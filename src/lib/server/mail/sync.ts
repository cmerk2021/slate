import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { getDb } from '../db';
import { log } from '../log';
import { publish } from '../events';
import { getImap } from './pool';
import { getAccount } from './accounts';
import { cacheGet, cachePut } from './bodycache';
import type { Address, FolderRow } from './types';

const ROLE_BY_SPECIAL: Record<string, string> = {
	'\\Inbox': 'inbox',
	'\\Sent': 'sent',
	'\\Drafts': 'drafts',
	'\\Trash': 'trash',
	'\\Junk': 'junk',
	'\\Archive': 'archive'
};

const ROLE_BY_NAME: [RegExp, string][] = [
	[/^inbox$/i, 'inbox'],
	[/^(sent|sent items|sent messages)$/i, 'sent'],
	[/^drafts?$/i, 'drafts'],
	[/^(trash|deleted( items| messages)?|bin)$/i, 'trash'],
	[/^(junk( e?-?mail)?|spam)$/i, 'junk'],
	[/^archive$/i, 'archive']
];

function detectRole(path: string, name: string, specialUse?: string): string | null {
	if (specialUse && ROLE_BY_SPECIAL[specialUse]) return ROLE_BY_SPECIAL[specialUse];
	if (path.toUpperCase() === 'INBOX') return 'inbox';
	for (const [re, role] of ROLE_BY_NAME) if (re.test(name)) return role;
	return null;
}

export async function syncFolders(accountId: number): Promise<void> {
	const client = await getImap(accountId);
	const db = getDb();
	const list = await client.list({ statusQuery: { messages: true, unseen: true } });
	const seen = new Set<string>();
	const upsert = db.prepare(`
		INSERT INTO folders (account_id, path, name, delimiter, parent_path, role, total, unseen, watched, sort_order)
		VALUES (@account_id, @path, @name, @delimiter, @parent_path, @role, @total, @unseen, (@role = 'inbox'), @sort_order)
		ON CONFLICT(account_id, path) DO UPDATE SET name=@name, delimiter=@delimiter, parent_path=@parent_path,
			role=COALESCE(@role, folders.role), total=@total, unseen=@unseen, sort_order=@sort_order`);
	const roleOrder: Record<string, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 };
	const tx = db.transaction(() => {
		for (const box of list) {
			seen.add(box.path);
			const role = detectRole(box.path, box.name, box.specialUse);
			upsert.run({
				account_id: accountId,
				path: box.path,
				name: box.path.toUpperCase() === 'INBOX' ? 'Inbox' : box.name,
				delimiter: box.delimiter ?? null,
				parent_path: box.parentPath || null,
				role,
				total: box.status?.messages ?? 0,
				unseen: box.status?.unseen ?? 0,
				sort_order: role != null && role in roleOrder ? roleOrder[role] : 10
			});
		}
		const existing = db.prepare('SELECT id, path FROM folders WHERE account_id = ?').all(accountId) as { id: number; path: string }[];
		for (const f of existing) {
			if (!seen.has(f.path)) db.prepare('DELETE FROM folders WHERE id = ?').run(f.id);
		}
	});
	tx();
	const acc = getAccount(accountId);
	publish({ type: 'folders', profileId: acc?.profile_id, data: { accountId } });
}

function addrList(a: AddressObject | AddressObject[] | undefined): Address[] {
	if (!a) return [];
	const arr = Array.isArray(a) ? a : [a];
	return arr.flatMap((x) => x.value.map((v) => ({ name: v.name || '', address: v.address || '' })));
}

export function computeThreadKey(messageId: string | null, inReplyTo: string | null, references: string | null, subject: string): string {
	const refs = (references ?? '').match(/<[^>]+>/g);
	if (refs && refs.length > 0) return refs[0];
	if (inReplyTo) {
		const m = inReplyTo.match(/<[^>]+>/);
		if (m) return m[0];
	}
	if (messageId) return messageId;
	return 'subj:' + subject.replace(/^((re|fwd?|aw|sv|vs)(\[\d+\])?:\s*)+/i, '').trim().toLowerCase();
}

interface EnvelopeAddr { name?: string; address?: string }

function envAddrs(list: EnvelopeAddr[] | undefined): Address[] {
	return (list ?? []).map((a) => ({ name: a.name || '', address: a.address || '' }));
}

/** Incremental header sync for one folder. */
export async function syncFolder(accountId: number, folderId: number): Promise<{ newMessages: number }> {
	const db = getDb();
	const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined;
	if (!folder) return { newMessages: 0 };
	const client = await getImap(accountId);
	const lock = await client.getMailboxLock(folder.path);
	let newCount = 0;
	try {
		const mb = client.mailbox;
		if (!mb || typeof mb === 'boolean') return { newMessages: 0 };
		const uidValidity = Number(mb.uidValidity ?? 0);

		if (folder.uidvalidity !== null && folder.uidvalidity !== uidValidity) {
			db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId);
			folder.uidvalidity = null;
		}

		const maxUidRow = db.prepare('SELECT MAX(uid) m FROM messages WHERE folder_id = ?').get(folderId) as { m: number | null };
		const sinceUid = maxUidRow.m ?? 0;

		// 1) fetch new message headers
		if ((mb.exists ?? 0) > 0) {
			const range = sinceUid > 0 ? `${sinceUid + 1}:*` : buildInitialRange(mb.exists);
			const insert = db.prepare(`
				INSERT INTO messages (account_id, folder_id, uid, message_id, in_reply_to, refs, thread_key, subject,
					from_json, to_json, cc_json, reply_to_json, date, internal_date, seen, flagged, answered, draft,
					flags_json, size, snippet, has_attachments, list_id, list_unsubscribe, list_unsubscribe_post)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
				ON CONFLICT(folder_id, uid) DO NOTHING`);
			const ftsInsert = db.prepare('INSERT INTO message_fts (rowid, subject, from_addr, to_addr, body) VALUES (?, ?, ?, ?, ?)');

			for await (const msg of client.fetch(
				range,
				{ uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, headers: ['list-id', 'list-unsubscribe', 'list-unsubscribe-post', 'references'] },
				{ uid: true }
			)) {
				if (msg.uid <= sinceUid) continue;
				const env = msg.envelope;
				const headers = msg.headers ? parseHeaderBlock(msg.headers.toString()) : {};
				const flags = [...(msg.flags ?? new Set<string>())];
				const subject = env?.subject ?? '';
				const messageId = env?.messageId ?? null;
				const inReplyTo = env?.inReplyTo ?? null;
				const refs = headers['references'] ?? null;
				const hasAttach = hasAttachments(msg.bodyStructure);
				const res = insert.run(
					accountId, folderId, msg.uid, messageId, inReplyTo, refs,
					computeThreadKey(messageId, inReplyTo, refs, subject), subject,
					JSON.stringify(envAddrs(env?.from)), JSON.stringify(envAddrs(env?.to)),
					JSON.stringify(envAddrs(env?.cc)), JSON.stringify(envAddrs(env?.replyTo)),
					env?.date ? new Date(env.date).getTime() : null,
					msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
					flags.includes('\\Seen') ? 1 : 0, flags.includes('\\Flagged') ? 1 : 0,
					flags.includes('\\Answered') ? 1 : 0, flags.includes('\\Draft') ? 1 : 0,
					JSON.stringify(flags), msg.size ?? 0, '', hasAttach ? 1 : 0,
					headers['list-id'] ?? null, headers['list-unsubscribe'] ?? null, headers['list-unsubscribe-post'] ?? null
				);
				if (res.changes > 0) {
					newCount++;
					const rowid = Number(res.lastInsertRowid);
					ftsInsert.run(
						rowid, subject,
						envAddrs(env?.from).map((a) => `${a.name} ${a.address}`).join(' '),
						envAddrs(env?.to).map((a) => `${a.name} ${a.address}`).join(' '), ''
					);
				}
			}
		}

		// 2) flag sync + deletions for cached messages (bounded window of most recent 2000)
		const cached = db
			.prepare('SELECT id, uid, seen, flagged, answered, flags_json FROM messages WHERE folder_id = ? ORDER BY uid DESC LIMIT 2000')
			.all(folderId) as { id: number; uid: number; seen: number; flagged: number; answered: number; flags_json: string }[];
		if (cached.length > 0) {
			const minUid = cached[cached.length - 1].uid;
			const serverUids = new Set<number>();
			const updFlags = db.prepare('UPDATE messages SET seen = ?, flagged = ?, answered = ?, flags_json = ? WHERE id = ?');
			for await (const msg of client.fetch(`${minUid}:*`, { uid: true, flags: true }, { uid: true })) {
				serverUids.add(msg.uid);
				const row = cached.find((c) => c.uid === msg.uid);
				if (!row) continue;
				const flags = [...(msg.flags ?? new Set<string>())];
				const seen = flags.includes('\\Seen') ? 1 : 0;
				const flagged = flags.includes('\\Flagged') ? 1 : 0;
				const answered = flags.includes('\\Answered') ? 1 : 0;
				const fj = JSON.stringify(flags);
				if (seen !== row.seen || flagged !== row.flagged || answered !== row.answered || fj !== row.flags_json) {
					updFlags.run(seen, flagged, answered, fj, row.id);
				}
			}
			const del = db.prepare('DELETE FROM messages WHERE id = ?');
			const delFts = db.prepare('DELETE FROM message_fts WHERE rowid = ?');
			for (const c of cached) {
				// keep snoozed placeholders (they were moved server-side on purpose)
				if (!serverUids.has(c.uid)) {
					const sn = db.prepare('SELECT snoozed_until FROM messages WHERE id = ?').get(c.id) as { snoozed_until: number | null };
					if (sn?.snoozed_until) continue;
					del.run(c.id);
					delFts.run(c.id);
				}
			}
		}

		// 3) update folder stats
		const status = await client.status(folder.path, { messages: true, unseen: true, uidNext: true });
		db.prepare('UPDATE folders SET uidvalidity = ?, uidnext = ?, total = ?, unseen = ? WHERE id = ?').run(
			uidValidity, status.uidNext ?? null, status.messages ?? 0, status.unseen ?? 0, folderId
		);
	} finally {
		lock.release();
	}

	const acc = getAccount(accountId);
	publish({ type: 'mail', profileId: acc?.profile_id, data: { accountId, folderId, newMessages: newCount } });
	if (newCount > 0) publish({ type: 'badge', data: {} });
	return { newMessages: newCount };
}

function buildInitialRange(exists: number): string {
	// Initial sync: only the most recent 500 messages by sequence; older loads happen via loadOlder.
	const INITIAL = 500;
	if (exists <= INITIAL) return '1:*';
	return `${exists - INITIAL + 1}:*`;
}

/** Load a chunk of older messages (for infinite scroll past the initial window). */
export async function loadOlder(accountId: number, folderId: number, beforeUid: number, count = 200): Promise<number> {
	const db = getDb();
	const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) as FolderRow | undefined;
	if (!folder || beforeUid <= 1) return 0;
	const client = await getImap(accountId);
	const lock = await client.getMailboxLock(folder.path);
	let added = 0;
	try {
		const uids = (await client.search({ uid: `1:${beforeUid - 1}` }, { uid: true })) as number[] | false;
		if (!uids || uids.length === 0) return 0;
		const chunk = uids.slice(-count);
		const insert = db.prepare(`
			INSERT INTO messages (account_id, folder_id, uid, message_id, in_reply_to, refs, thread_key, subject,
				from_json, to_json, cc_json, reply_to_json, date, internal_date, seen, flagged, answered, draft,
				flags_json, size, snippet, has_attachments, list_id, list_unsubscribe, list_unsubscribe_post)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(folder_id, uid) DO NOTHING`);
		const ftsInsert = db.prepare('INSERT INTO message_fts (rowid, subject, from_addr, to_addr, body) VALUES (?, ?, ?, ?, ?)');
		for await (const msg of client.fetch(
			chunk.join(','),
			{ uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true, headers: ['list-id', 'list-unsubscribe', 'list-unsubscribe-post', 'references'] },
			{ uid: true }
		)) {
			const env = msg.envelope;
			const headers = msg.headers ? parseHeaderBlock(msg.headers.toString()) : {};
			const flags = [...(msg.flags ?? new Set<string>())];
			const subject = env?.subject ?? '';
			const refs = headers['references'] ?? null;
			const res = insert.run(
				accountId, folderId, msg.uid, env?.messageId ?? null, env?.inReplyTo ?? null, refs,
				computeThreadKey(env?.messageId ?? null, env?.inReplyTo ?? null, refs, subject), subject,
				JSON.stringify(envAddrs(env?.from)), JSON.stringify(envAddrs(env?.to)),
				JSON.stringify(envAddrs(env?.cc)), JSON.stringify(envAddrs(env?.replyTo)),
				env?.date ? new Date(env.date).getTime() : null,
				msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
				flags.includes('\\Seen') ? 1 : 0, flags.includes('\\Flagged') ? 1 : 0,
				flags.includes('\\Answered') ? 1 : 0, flags.includes('\\Draft') ? 1 : 0,
				JSON.stringify(flags), msg.size ?? 0, '', hasAttachments(msg.bodyStructure) ? 1 : 0,
				headers['list-id'] ?? null, headers['list-unsubscribe'] ?? null, headers['list-unsubscribe-post'] ?? null
			);
			if (res.changes > 0) {
				added++;
				ftsInsert.run(Number(res.lastInsertRowid), subject,
					envAddrs(env?.from).map((a) => `${a.name} ${a.address}`).join(' '),
					envAddrs(env?.to).map((a) => `${a.name} ${a.address}`).join(' '), '');
			}
		}
	} finally {
		lock.release();
	}
	return added;
}

function parseHeaderBlock(block: string): Record<string, string> {
	const out: Record<string, string> = {};
	const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
	for (const line of unfolded.split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
	}
	return out;
}

interface BodyStructNode {
	type?: string;
	disposition?: string;
	childNodes?: BodyStructNode[];
}

function hasAttachments(node: BodyStructNode | undefined): boolean {
	if (!node) return false;
	if (node.disposition === 'attachment') return true;
	if (node.childNodes) return node.childNodes.some(hasAttachments);
	return false;
}

/** Fetch raw message source (cached on disk) and parse it. */
export async function fetchParsedMessage(accountId: number, folderId: number, uid: number): Promise<ParsedMail> {
	const key = `body:${accountId}:${folderId}:${uid}`;
	let raw = cacheGet(key);
	if (!raw) {
		const db = getDb();
		const folder = db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | undefined;
		if (!folder) throw new Error('Folder not found');
		const client = await getImap(accountId);
		const lock = await client.getMailboxLock(folder.path);
		try {
			const dl = await client.download(String(uid), undefined, { uid: true });
			if (!dl?.content) throw new Error('Message not found on server');
			const chunks: Buffer[] = [];
			for await (const chunk of dl.content) chunks.push(chunk as Buffer);
			raw = Buffer.concat(chunks);
		} finally {
			lock.release();
		}
		cachePut(key, raw);
		indexBody(accountId, folderId, uid, raw).catch((e) => log.debug('fts index failed', { error: String(e) }));
	}
	return simpleParser(raw);
}

async function indexBody(accountId: number, folderId: number, uid: number, raw: Buffer) {
	const db = getDb();
	const row = db.prepare('SELECT id, subject, from_json, to_json, body_indexed FROM messages WHERE folder_id = ? AND uid = ?').get(folderId, uid) as
		| { id: number; subject: string; from_json: string; to_json: string; body_indexed: number }
		| undefined;
	if (!row || row.body_indexed) return;
	const parsed = await simpleParser(raw);
	const text = (parsed.text || htmlToText(parsed.html || '') || '').slice(0, 100_000);
	const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 140);
	const from = (JSON.parse(row.from_json) as Address[]).map((a) => `${a.name} ${a.address}`).join(' ');
	const to = (JSON.parse(row.to_json) as Address[]).map((a) => `${a.name} ${a.address}`).join(' ');
	db.prepare('DELETE FROM message_fts WHERE rowid = ?').run(row.id);
	db.prepare('INSERT INTO message_fts (rowid, subject, from_addr, to_addr, body) VALUES (?, ?, ?, ?, ?)').run(row.id, row.subject, from, to, text);
	db.prepare('UPDATE messages SET body_indexed = 1, snippet = ? WHERE id = ?').run(snippet, row.id);
}

export function htmlToText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}
