import { getDb } from '../db';
import { getImap } from './pool';
import { parseSearchQuery, ftsQuote, type ParsedQuery } from './searchquery';
import { rowToListItem, type MessageRow, type MessageListItem } from './types';
import { log } from '../log';

export interface SearchResult extends MessageListItem {
	source: 'local' | 'server';
}

/** Local FTS5 search over cached headers/bodies. */
export function searchLocal(profileId: number, q: ParsedQuery, limit = 100): SearchResult[] {
	const db = getDb();
	const where: string[] = ['a.profile_id = ?'];
	const params: unknown[] = [profileId];

	let joinFts = '';
	if (q.text) {
		joinFts = 'JOIN message_fts fts ON fts.rowid = m.id';
		where.push('message_fts MATCH ?');
		params.push(ftsQuote(q.text));
	}
	if (q.from) { where.push("m.from_json LIKE '%' || ? || '%'"); params.push(q.from); }
	if (q.to) { where.push("m.to_json LIKE '%' || ? || '%'"); params.push(q.to); }
	if (q.subject) { where.push("m.subject LIKE '%' || ? || '%'"); params.push(q.subject); }
	if (q.hasAttachment) where.push('m.has_attachments = 1');
	if (q.unread === true) where.push('m.seen = 0');
	if (q.unread === false) where.push('m.seen = 1');
	if (q.starred) where.push('m.flagged = 1');
	if (q.inFolder) { where.push('(f.name LIKE ? OR f.path LIKE ?)'); params.push(q.inFolder, q.inFolder); }
	if (q.before) { where.push('m.internal_date < ?'); params.push(q.before.getTime()); }
	if (q.after) { where.push('m.internal_date > ?'); params.push(q.after.getTime()); }

	const sql = `
		SELECT m.* FROM messages m
		${joinFts}
		JOIN folders f ON f.id = m.folder_id
		JOIN accounts a ON a.id = m.account_id
		WHERE ${where.join(' AND ')}
		ORDER BY m.internal_date DESC
		LIMIT ?`;
	params.push(limit);
	const rows = db.prepare(sql).all(...params) as MessageRow[];
	return rows.map((r) => ({ ...rowToListItem(r), source: 'local' as const }));
}

/** Server-side IMAP SEARCH across each account's inbox (and archive) for messages not cached. */
export async function searchServer(profileId: number, q: ParsedQuery, limit = 50): Promise<SearchResult[]> {
	const db = getDb();
	const accounts = db.prepare("SELECT id FROM accounts WHERE profile_id = ? AND kind = 'imap'").all(profileId) as { id: number }[];
	const results: SearchResult[] = [];

	for (const acc of accounts) {
		try {
			const folders = db
				.prepare("SELECT id, path FROM folders WHERE account_id = ? AND (role IN ('inbox','archive','sent') OR watched = 1)")
				.all(acc.id) as { id: number; path: string }[];
			const client = await getImap(acc.id);
			for (const folder of folders) {
				const crit: Record<string, unknown> = {};
				if (q.text) crit.or = [{ body: q.text }, { subject: q.text }];
				if (q.from) crit.from = q.from;
				if (q.to) crit.to = q.to;
				if (q.subject) crit.subject = q.subject;
				if (q.unread === true) crit.seen = false;
				if (q.starred) crit.flagged = true;
				if (q.before) crit.before = q.before;
				if (q.after) crit.since = q.after;
				if (Object.keys(crit).length === 0) continue;

				const lock = await client.getMailboxLock(folder.path);
				try {
					const uids = (await client.search(crit as never, { uid: true })) as number[] | false;
					if (!uids || uids.length === 0) continue;
					const found = uids.slice(-limit);
					const placeholders = found.map(() => '?').join(',');
					const cachedRows = db
						.prepare(`SELECT * FROM messages WHERE folder_id = ? AND uid IN (${placeholders})`)
						.all(folder.id, ...found) as MessageRow[];
					const cachedUids = new Set(cachedRows.map((r) => r.uid));
					for (const r of cachedRows) results.push({ ...rowToListItem(r), source: 'server' });
					const missing = found.filter((u) => !cachedUids.has(u)).slice(-20);
					if (missing.length > 0) {
						for await (const m of client.fetch(missing.join(','), { uid: true, envelope: true, flags: true, internalDate: true }, { uid: true })) {
							const env = m.envelope;
							results.push({
								id: -m.uid,
								accountId: acc.id,
								folderId: folder.id,
								uid: m.uid,
								subject: env?.subject ?? '',
								from: (env?.from ?? []).map((a) => ({ name: a.name || '', address: a.address || '' })),
								to: (env?.to ?? []).map((a) => ({ name: a.name || '', address: a.address || '' })),
								date: m.internalDate ? new Date(m.internalDate).getTime() : 0,
								seen: m.flags?.has('\\Seen') ?? false,
								flagged: m.flags?.has('\\Flagged') ?? false,
								answered: false,
								draft: false,
								snippet: '',
								hasAttachments: false,
								threadKey: null,
								snoozedUntil: null,
								messageId: env?.messageId ?? null,
								listId: null,
								source: 'server'
							});
						}
					}
				} finally {
					lock.release();
				}
			}
		} catch (err) {
			log.warn('server search failed', { accountId: acc.id, error: String(err) });
		}
	}
	return results;
}

export async function search(profileId: number, query: string, includeServer: boolean): Promise<{ local: SearchResult[]; server: SearchResult[] }> {
	const q = parseSearchQuery(query);
	const local = searchLocal(profileId, q);
	let server: SearchResult[] = [];
	if (includeServer) {
		const seen = new Set(local.map((r) => `${r.accountId}:${r.folderId}:${r.uid}`));
		server = (await searchServer(profileId, q)).filter((r) => {
			const key = `${r.accountId}:${r.folderId}:${r.uid}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
	return { local, server };
}
