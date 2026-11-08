import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { rowToListItem, type MessageRow, type Address } from '$lib/server/mail/types';
import { fetchParsedMessage, loadOlder, syncFolder } from '$lib/server/mail/sync';
import { setFlags, moveMessages, deleteMessages, archiveMessages, markSpam, snoozeMessages, unsnoozeMessages, folderByRole } from '$lib/server/mail/actions';
import { sanitizeEmailHtml, wrapEmailDocument } from '$lib/server/mail/sanitize';
import { queueSend, cancelSend, retrySend, pendingOutbox, buildMime } from '$lib/server/mail/send';
import { computeReply, replySubject, forwardSubject, attributionLine, quoteHtml, quoteText, htmlToPlainText, escapeHtml } from '$lib/server/mail/compose';
import { connectionState, getImap } from '$lib/server/mail/pool';
import { getAccount } from '$lib/server/mail/accounts';
import { getProfileSetting, setProfileSetting } from '$lib/server/profiles';
import { parseImip, type ImipInvite } from '$lib/server/dav/ics';
import { env } from '$lib/server/env';
import { log } from '$lib/server/log';
import { randomUUID } from 'node:crypto';

function requireAuth(locals: App.Locals) {
	if (!locals.session) throw error(401, 'Unauthorized');
}

/** GET /api/mail?view=list&folder=..&profile=.. etc. */
export const GET: RequestHandler = async ({ locals, url }) => {
	requireAuth(locals);
	const db = getDb();
	const view = url.searchParams.get('view') ?? 'list';
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);

	if (view === 'folders') {
		const folders = db
			.prepare(`SELECT f.*, a.name account_name, a.email account_email FROM folders f JOIN accounts a ON a.id = f.account_id
				WHERE a.profile_id = ? ORDER BY a.id, f.sort_order, f.path`)
			.all(profileId);
		const conns = (db.prepare("SELECT id FROM accounts WHERE profile_id = ? AND kind IN ('imap','pop3')").all(profileId) as { id: number }[])
			.map((a) => ({ accountId: a.id, ...connectionState(a.id) }));
		const snoozedCount = (db
			.prepare(`SELECT COUNT(*) c FROM messages m JOIN accounts a ON a.id = m.account_id WHERE a.profile_id = ? AND m.snoozed_until IS NOT NULL`)
			.get(profileId) as { c: number }).c;
		return json({ folders, connections: conns, snoozedCount });
	}

	if (view === 'list') {
		const folderId = parseInt(url.searchParams.get('folder') ?? '0', 10);
		const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
		const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 200);
		const unified = url.searchParams.get('unified') === '1';
		const snoozedView = url.searchParams.get('snoozed') === '1';
		const splitId = url.searchParams.get('split');

		let rows: MessageRow[];
		if (snoozedView) {
			rows = db.prepare(`SELECT m.* FROM messages m JOIN accounts a ON a.id = m.account_id
				WHERE a.profile_id = ? AND m.snoozed_until IS NOT NULL ORDER BY m.snoozed_until ASC LIMIT ? OFFSET ?`).all(profileId, limit, offset) as MessageRow[];
		} else if (unified) {
			rows = db.prepare(`SELECT m.* FROM messages m
				JOIN folders f ON f.id = m.folder_id AND f.role = 'inbox'
				JOIN accounts a ON a.id = m.account_id
				WHERE a.profile_id = ? AND m.snoozed_until IS NULL
				ORDER BY m.internal_date DESC LIMIT ? OFFSET ?`).all(profileId, limit, offset) as MessageRow[];
		} else {
			rows = db.prepare(`SELECT * FROM messages WHERE folder_id = ? AND snoozed_until IS NULL
				ORDER BY internal_date DESC LIMIT ? OFFSET ?`).all(folderId, limit, offset) as MessageRow[];
		}

		let items = rows.map(rowToListItem);

		// split inbox filtering
		if (splitId && splitId !== 'all') {
			const splits = db.prepare('SELECT * FROM splits WHERE profile_id = ? ORDER BY sort_order').all(profileId) as { id: number; rules_json: string }[];
			if (splitId === 'other') {
				const allRules = splits.map((s) => JSON.parse(s.rules_json));
				items = items.filter((m) => !allRules.some((rules) => matchesRules(m, rules)));
			} else {
				const split = splits.find((s) => s.id === parseInt(splitId, 10));
				if (split) {
					const rules = JSON.parse(split.rules_json);
					items = items.filter((m) => matchesRules(m, rules));
				}
			}
		}

		// thread counts
		const keys = [...new Set(items.map((i) => i.threadKey).filter(Boolean))] as string[];
		if (keys.length > 0) {
			const counts = db.prepare(`SELECT thread_key k, COUNT(*) c, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) u
				FROM messages m JOIN accounts a ON a.id = m.account_id
				WHERE a.profile_id = ? AND thread_key IN (${keys.map(() => '?').join(',')})
				GROUP BY thread_key`).all(profileId, ...keys) as { k: string; c: number; u: number }[];
			const map = new Map(counts.map((c) => [c.k, c]));
			for (const i of items) {
				const c = i.threadKey ? map.get(i.threadKey) : undefined;
				if (c) {
					i.threadCount = c.c;
					i.threadUnread = c.u;
				}
			}
		}
		return json({ messages: items });
	}

	if (view === 'thread') {
		const threadKey = url.searchParams.get('key') ?? '';
		const rows = db.prepare(`SELECT m.* FROM messages m JOIN accounts a ON a.id = m.account_id
			WHERE a.profile_id = ? AND m.thread_key = ? ORDER BY m.internal_date ASC`).all(profileId, threadKey) as MessageRow[];
		return json({ messages: rows.map(rowToListItem) });
	}

	if (view === 'message') {
		const id = parseInt(url.searchParams.get('id') ?? '0', 10);
		const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
		if (!row) throw error(404, 'Message not found');
		const acc = getAccount(row.account_id);
		if (!acc || acc.profile_id !== profileId) throw error(403, 'Forbidden');

		let parsed;
		try {
			parsed = await fetchParsedMessage(row.account_id, row.folder_id, row.uid);
		} catch (err) {
			return json({ error: 'Could not load the message: ' + (err instanceof Error ? err.message : 'unknown'), retry: true }, { status: 502 });
		}

		// trusted-sender remote image policy
		const sender = (JSON.parse(row.from_json) as Address[])[0]?.address?.toLowerCase() ?? '';
		const domain = sender.split('@')[1] ?? '';
		const trusted = db.prepare('SELECT 1 FROM trusted_senders WHERE profile_id = ? AND sender IN (?, ?)').get(profileId, sender, '@' + domain);
		const allowRemote = !!trusted || url.searchParams.get('images') === '1';
		const dark = url.searchParams.get('dark') === '1';
		const adaptDark = url.searchParams.get('adapt') !== '0';

		const attachments = (parsed.attachments ?? []).map((a, i) => ({
			index: i,
			filename: a.filename ?? `attachment-${i}`,
			contentType: a.contentType,
			size: a.size,
			cid: a.cid ?? null
		}));

		const cidResolver = (cid: string) => {
			const idx = (parsed.attachments ?? []).findIndex((a) => a.cid === cid || a.cid === `<${cid}>`);
			return idx >= 0 ? `/api/mail?view=attachment&profile=${profileId}&id=${id}&att=${idx}` : null;
		};

		let html = '';
		let sanitizeMeta = { remoteImages: 0, trackersBlocked: 0 };
		if (parsed.html) {
			const result = sanitizeEmailHtml(parsed.html, { allowRemote, proxyBase: '/api/proxy/image?url=', cidResolver });
			html = wrapEmailDocument(result.html, { dark, adaptDark });
			sanitizeMeta = { remoteImages: result.remoteImages, trackersBlocked: result.trackersBlocked };
		} else if (parsed.text) {
			html = wrapEmailDocument(`<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(parsed.text)}</pre>`, { dark, adaptDark });
		}

		// mark seen
		if (!row.seen) void setFlags([id], 'seen', true).catch((e) => log.warn('mark seen failed', { error: String(e) }));

		// detect iMIP invite
		let invite: (Omit<ImipInvite, 'rawIcs'> & { icsIndex: number }) | null = null;
		const calAtt = (parsed.attachments ?? []).findIndex((a) => a.contentType === 'text/calendar' || a.filename?.endsWith('.ics'));
		if (calAtt >= 0) {
			const parsed2 = parseImip(parsed.attachments[calAtt].content.toString('utf8'));
			if (parsed2) {
				const { rawIcs: _r, ...rest } = parsed2;
				invite = { ...rest, icsIndex: calAtt };
			}
		} else if (typeof parsed.headers.get('content-type') === 'object') {
			// text/calendar as body part handled via attachments by mailparser in most cases
		}

		const isNewsletter = !!row.list_id || /unsubscribe/i.test(parsed.html || parsed.text || '');

		return json({
			message: rowToListItem(row),
			html,
			text: parsed.text ?? htmlToPlainText(parsed.html || ''),
			attachments,
			headers: {
				from: JSON.parse(row.from_json),
				to: JSON.parse(row.to_json),
				cc: JSON.parse(row.cc_json),
				replyTo: JSON.parse(row.reply_to_json),
				date: row.date,
				messageId: row.message_id,
				listUnsubscribe: row.list_unsubscribe,
				listUnsubscribePost: row.list_unsubscribe_post
			},
			remoteImages: sanitizeMeta.remoteImages,
			trackersBlocked: sanitizeMeta.trackersBlocked,
			imagesAllowed: allowRemote,
			invite,
			isNewsletter
		});
	}

	if (view === 'attachment') {
		const id = parseInt(url.searchParams.get('id') ?? '0', 10);
		const att = parseInt(url.searchParams.get('att') ?? '0', 10);
		const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
		if (!row) throw error(404, 'Not found');
		const acc = getAccount(row.account_id);
		if (!acc || acc.profile_id !== profileId) throw error(403, 'Forbidden');
		const parsed = await fetchParsedMessage(row.account_id, row.folder_id, row.uid);
		const a = parsed.attachments?.[att];
		if (!a) throw error(404, 'Attachment not found');
		const download = url.searchParams.get('dl') === '1';
		return new Response(new Uint8Array(a.content), {
			headers: {
				'Content-Type': a.contentType || 'application/octet-stream',
				'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${(a.filename ?? 'attachment').replace(/"/g, '')}"`,
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
			}
		});
	}

	if (view === 'outbox') {
		return json({ pending: pendingOutbox(profileId) });
	}

	if (view === 'identities') {
		const rows = db.prepare(`SELECT i.*, a.name account_name FROM identities i JOIN accounts a ON a.id = i.account_id
			WHERE a.profile_id = ? AND a.kind IN ('imap','pop3') ORDER BY i.account_id, i.is_default DESC`).all(profileId);
		return json({ identities: rows });
	}

	if (view === 'splits') {
		const splits = db.prepare('SELECT * FROM splits WHERE profile_id = ? ORDER BY sort_order').all(profileId);
		return json({ splits });
	}

	throw error(400, 'Unknown view');
};

interface SplitRule { field: string; op?: string; value: string }

function matchesRules(m: { from: Address[]; listId: string | null; hasAttachments: boolean; flagged: boolean; subject: string }, rules: SplitRule[]): boolean {
	return rules.some((r) => {
		const v = r.value.toLowerCase();
		switch (r.field) {
			case 'sender': return m.from.some((f) => f.address.toLowerCase().includes(v));
			case 'domain': return m.from.some((f) => f.address.toLowerCase().endsWith('@' + v) || f.address.toLowerCase().endsWith('.' + v));
			case 'list': return !!m.listId && (v === '*' || m.listId.toLowerCase().includes(v));
			case 'has-attachment': return m.hasAttachments;
			case 'starred': return m.flagged;
			case 'subject': return m.subject.toLowerCase().includes(v);
			default: return false;
		}
	});
}

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	const body = await request.json();
	const action = body.action as string;
	const db = getDb();

	try {
		switch (action) {
			case 'flag': {
				await setFlags(body.ids, body.flag, body.value);
				return json({ ok: true });
			}
			case 'archive': {
				await archiveMessages(body.ids);
				return json({ ok: true });
			}
			case 'delete': {
				await deleteMessages(body.ids, body.permanent);
				return json({ ok: true });
			}
			case 'spam': {
				await markSpam(body.ids);
				return json({ ok: true });
			}
			case 'move': {
				await moveMessages(body.ids, { folderId: body.folderId, role: body.role });
				return json({ ok: true });
			}
			case 'snooze': {
				snoozeMessages(body.ids, body.until);
				return json({ ok: true });
			}
			case 'unsnooze': {
				unsnoozeMessages(body.ids);
				return json({ ok: true });
			}
			case 'sync-folder': {
				await syncFolder(body.accountId, body.folderId);
				return json({ ok: true });
			}
			case 'load-older': {
				const added = await loadOlder(body.accountId, body.folderId, body.beforeUid);
				return json({ ok: true, added });
			}
			case 'trust-sender': {
				db.prepare('INSERT OR IGNORE INTO trusted_senders (profile_id, sender) VALUES (?, ?)').run(body.profileId, body.sender.toLowerCase());
				return json({ ok: true });
			}
			case 'untrust-sender': {
				db.prepare('DELETE FROM trusted_senders WHERE profile_id = ? AND sender = ?').run(body.profileId, body.sender.toLowerCase());
				return json({ ok: true });
			}
			case 'send': {
				return await handleSend(body);
			}
			case 'cancel-send': {
				const ok = cancelSend(body.outboxId);
				return json({ ok });
			}
			case 'retry-send': {
				retrySend(body.outboxId);
				return json({ ok: true });
			}
			case 'save-draft': {
				return await saveDraft(body);
			}
			case 'delete-draft': {
				if (body.draftId) db.prepare('DELETE FROM drafts_local WHERE id = ?').run(body.draftId);
				return json({ ok: true });
			}
			case 'unsubscribe': {
				return await handleUnsubscribe(body);
			}
			case 'save-splits': {
				db.prepare('DELETE FROM splits WHERE profile_id = ?').run(body.profileId);
				const ins = db.prepare('INSERT INTO splits (profile_id, name, rules_json, sort_order) VALUES (?, ?, ?, ?)');
				(body.splits as { name: string; rules: SplitRule[] }[]).forEach((s, i) => ins.run(body.profileId, s.name, JSON.stringify(s.rules), i));
				return json({ ok: true });
			}
			case 'watch-folder': {
				db.prepare('UPDATE folders SET watched = ? WHERE id = ?').run(body.watched ? 1 : 0, body.folderId);
				return json({ ok: true });
			}
			default:
				throw error(400, 'Unknown action');
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		log.warn('mail action failed', { action, error: err instanceof Error ? err.message : String(err) });
		return json({ ok: false, error: err instanceof Error ? err.message : 'Action failed' }, { status: 500 });
	}
};

interface SendBody {
	profileId: number;
	identityId: number;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
	html: string;
	attachments?: { filename: string; contentType: string; dataBase64: string; cid?: string }[];
	replyToMessageId?: number; // db id of original
	mode?: 'reply' | 'replyAll' | 'forward' | 'new';
	delayOverride?: number;
	icalReply?: string; // iMIP reply payload
}

async function handleSend(body: SendBody) {
	const db = getDb();
	const identity = db.prepare('SELECT i.*, a.id account_id, a.profile_id FROM identities i JOIN accounts a ON a.id = i.account_id WHERE i.id = ?').get(body.identityId) as
		| { id: number; email: string; name: string; account_id: number; profile_id: number }
		| undefined;
	if (!identity || identity.profile_id !== body.profileId) throw error(400, 'Invalid identity');

	const maxBytes = env.MAX_ATTACHMENT_MB * 1024 * 1024;
	let totalAtt = 0;
	const attachments = (body.attachments ?? []).map((a) => {
		const content = Buffer.from(a.dataBase64, 'base64');
		totalAtt += content.length;
		return { filename: a.filename, contentType: a.contentType, content, ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {}) };
	});
	if (totalAtt > maxBytes) throw error(413, `Attachments exceed the ${env.MAX_ATTACHMENT_MB} MB limit`);

	let inReplyTo: string | undefined;
	let references: string | undefined;
	let setFlag: 'answered' | 'forwarded' | undefined;
	if (body.replyToMessageId && body.mode && body.mode !== 'new') {
		const orig = db.prepare('SELECT message_id, refs FROM messages WHERE id = ?').get(body.replyToMessageId) as { message_id: string | null; refs: string | null } | undefined;
		if (orig) {
			const r = computeReply(
				{ from: [], to: [], cc: [], replyTo: [], messageId: orig.message_id, references: orig.refs, ownAddresses: [] },
				'reply'
			);
			inReplyTo = r.inReplyTo ?? undefined;
			references = r.references || undefined;
		}
		setFlag = body.mode === 'forward' ? 'forwarded' : 'answered';
	}

	const text = htmlToPlainText(body.html);
	const fmt = (a: Address) => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address);

	if (body.icalReply) {
		attachments.push({
			filename: 'reply.ics',
			contentType: 'text/calendar; method=REPLY',
			content: Buffer.from(body.icalReply, 'utf8')
		} as never);
	}

	const { outboxId, sendAt } = await queueSend(
		{
			accountId: identity.account_id,
			from: fmt({ name: identity.name, address: identity.email }),
			to: body.to.map(fmt).join(', ') || undefined,
			cc: body.cc.length ? body.cc.map(fmt).join(', ') : undefined,
			bcc: body.bcc.length ? body.bcc.map(fmt).join(', ') : undefined,
			subject: body.subject,
			html: body.html,
			text,
			attachments,
			inReplyTo,
			references,
			messageId: `<${randomUUID()}@slate>`
		},
		{ inReplyToMsgDbId: body.replyToMessageId, setFlag, delayOverride: body.delayOverride }
	);
	return json({ ok: true, outboxId, sendAt });
}

interface DraftBody {
	profileId: number;
	identityId: number;
	draftId?: number;
	data: { to: Address[]; cc: Address[]; bcc: Address[]; subject: string; html: string };
}

/** Autosave draft to the IMAP Drafts folder (replace-on-save), with a local row to track the UID. */
async function saveDraft(body: DraftBody) {
	const db = getDb();
	const identity = db.prepare('SELECT i.*, a.id account_id, a.profile_id, a.kind FROM identities i JOIN accounts a ON a.id = i.account_id WHERE i.id = ?').get(body.identityId) as
		| { email: string; name: string; account_id: number; profile_id: number; kind: string }
		| undefined;
	if (!identity || identity.profile_id !== body.profileId) throw error(400, 'Invalid identity');

	let draftId = body.draftId;
	if (!draftId) {
		const res = db.prepare('INSERT INTO drafts_local (account_id, data_json, updated_at) VALUES (?, ?, ?)').run(identity.account_id, JSON.stringify(body.data), Date.now());
		draftId = Number(res.lastInsertRowid);
	} else {
		db.prepare('UPDATE drafts_local SET data_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(body.data), Date.now(), draftId);
	}

	if (identity.kind === 'imap') {
		try {
			const fmt = (a: Address) => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address);
			const mime = await buildMime({
				from: fmt({ name: identity.name, address: identity.email }),
				to: body.data.to.map(fmt).join(', ') || undefined,
				cc: body.data.cc.length ? body.data.cc.map(fmt).join(', ') : undefined,
				subject: body.data.subject,
				html: body.data.html,
				text: htmlToPlainText(body.data.html)
			});
			const drafts = folderByRole(identity.account_id, 'drafts');
			if (drafts) {
				const client = await getImap(identity.account_id);
				const old = db.prepare('SELECT draft_uid FROM drafts_local WHERE id = ?').get(draftId) as { draft_uid: number | null };
				const appended = await client.append(drafts.path, mime, ['\\Draft', '\\Seen']);
				if (old?.draft_uid) {
					const lock = await client.getMailboxLock(drafts.path);
					try {
						await client.messageDelete(String(old.draft_uid), { uid: true });
					} finally {
						lock.release();
					}
				}
				db.prepare('UPDATE drafts_local SET draft_uid = ? WHERE id = ?').run(appended && typeof appended === 'object' ? appended.uid ?? null : null, draftId);
			}
		} catch (err) {
			log.warn('imap draft save failed (kept locally)', { error: err instanceof Error ? err.message : String(err) });
		}
	}
	return json({ ok: true, draftId });
}

async function handleUnsubscribe(body: { messageId: number; profileId: number }) {
	const db = getDb();
	const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(body.messageId) as MessageRow | undefined;
	if (!row || !row.list_unsubscribe) throw error(400, 'No unsubscribe information');
	const acc = getAccount(row.account_id);
	if (!acc || acc.profile_id !== body.profileId) throw error(403, 'Forbidden');

	const targets = [...row.list_unsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
	const httpUrl = targets.find((t) => t.startsWith('http'));
	const mailtoUrl = targets.find((t) => t.startsWith('mailto:'));

	// RFC 8058 one-click
	if (httpUrl && /one-click/i.test(row.list_unsubscribe_post ?? '')) {
		try {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), 15000);
			const res = await fetch(httpUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'List-Unsubscribe=One-Click',
				signal: ctrl.signal
			});
			clearTimeout(t);
			if (res.ok || res.status === 202) return json({ ok: true, method: 'one-click' });
		} catch { /* fall through */ }
	}
	if (mailtoUrl) {
		const url = new URL(mailtoUrl);
		const to = url.pathname;
		const subject = url.searchParams.get('subject') ?? 'unsubscribe';
		const identity = db.prepare('SELECT id FROM identities WHERE account_id = ? ORDER BY is_default DESC LIMIT 1').get(row.account_id) as { id: number } | undefined;
		if (identity) {
			await handleSend({
				profileId: body.profileId, identityId: identity.id,
				to: [{ name: '', address: to }], cc: [], bcc: [],
				subject, html: '<p>unsubscribe</p>', mode: 'new', delayOverride: 0
			});
			return json({ ok: true, method: 'mailto' });
		}
	}
	if (httpUrl) return json({ ok: true, method: 'link', url: httpUrl });
	throw error(400, 'No usable unsubscribe method');
}

/** Build reply/forward prefill for the composer. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	const body = await request.json();
	const db = getDb();
	const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(body.messageId) as MessageRow | undefined;
	if (!row) throw error(404, 'Message not found');
	const acc = getAccount(row.account_id);
	if (!acc) throw error(404, 'Account not found');

	const ownAddresses = (db.prepare('SELECT i.email FROM identities i JOIN accounts a ON a.id = i.account_id WHERE a.profile_id = ?').all(acc.profile_id) as { email: string }[]).map((r) => r.email);

	const parsed = await fetchParsedMessage(row.account_id, row.folder_id, row.uid);
	const origHtml = parsed.html || `<pre style="white-space:pre-wrap">${escapeHtml(parsed.text ?? '')}</pre>`;
	const from = JSON.parse(row.from_json) as Address[];
	const attribution = attributionLine(from, new Date(row.date ?? row.internal_date ?? Date.now()));

	const mode = body.mode as 'reply' | 'replyAll' | 'forward';
	if (mode === 'forward') {
		const atts = (parsed.attachments ?? []).map((a, i) => ({
			filename: a.filename ?? `attachment-${i}`,
			contentType: a.contentType,
			dataBase64: a.content.toString('base64')
		}));
		return json({
			to: [], cc: [],
			subject: forwardSubject(row.subject),
			html: `<p></p><p>---------- Forwarded message ----------<br>From: ${escapeHtml(from.map((f) => f.name || f.address).join(', '))}<br>Subject: ${escapeHtml(row.subject)}</p>` + origHtml,
			attachments: atts,
			replyToMessageId: row.id
		});
	}

	const sanitized = sanitizeEmailHtml(origHtml, { allowRemote: false });
	const r = computeReply(
		{
			from,
			to: JSON.parse(row.to_json),
			cc: JSON.parse(row.cc_json),
			replyTo: JSON.parse(row.reply_to_json),
			messageId: row.message_id,
			references: row.refs,
			ownAddresses
		},
		mode === 'replyAll' ? 'replyAll' : 'reply'
	);
	return json({
		to: r.to,
		cc: r.cc,
		subject: replySubject(row.subject),
		html: '<p></p>' + quoteHtml(sanitized.html, attribution),
		textQuote: quoteText(parsed.text ?? '', attribution),
		replyToMessageId: row.id
	});
};
