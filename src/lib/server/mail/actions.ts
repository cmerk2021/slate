import { getDb } from '../db';
import { getImap } from './pool';
import { getAccount } from './accounts';
import { publish } from '../events';
import type { FolderRow, MessageRow } from './types';

function folderById(id: number): FolderRow | null {
	return (getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined) ?? null;
}

export function folderByRole(accountId: number, role: string): FolderRow | null {
	return (getDb().prepare('SELECT * FROM folders WHERE account_id = ? AND role = ? LIMIT 1').get(accountId, role) as FolderRow | undefined) ?? null;
}

function msg(id: number): MessageRow | null {
	return (getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) ?? null;
}

async function withMailbox<T>(accountId: number, path: string, fn: (client: Awaited<ReturnType<typeof getImap>>) => Promise<T>): Promise<T> {
	const client = await getImap(accountId);
	const lock = await client.getMailboxLock(path);
	try {
		return await fn(client);
	} finally {
		lock.release();
	}
}

function notify(accountId: number, folderId?: number) {
	const acc = getAccount(accountId);
	publish({ type: 'mail', profileId: acc?.profile_id, data: { accountId, folderId } });
	publish({ type: 'badge', data: {} });
}

export async function setFlags(messageIds: number[], flag: 'seen' | 'flagged' | 'answered', value: boolean) {
	const db = getDb();
	// group by account+folder
	const groups = new Map<string, { accountId: number; folderId: number; path: string; uids: number[]; ids: number[] }>();
	for (const id of messageIds) {
		const m = msg(id);
		if (!m) continue;
		const f = folderById(m.folder_id);
		if (!f) continue;
		const key = `${m.account_id}:${m.folder_id}`;
		if (!groups.has(key)) groups.set(key, { accountId: m.account_id, folderId: m.folder_id, path: f.path, uids: [], ids: [] });
		groups.get(key)!.uids.push(m.uid);
		groups.get(key)!.ids.push(id);
	}
	const imapFlag = flag === 'seen' ? '\\Seen' : flag === 'flagged' ? '\\Flagged' : '\\Answered';
	const col = flag === 'seen' ? 'seen' : flag === 'flagged' ? 'flagged' : 'answered';
	for (const g of groups.values()) {
		// optimistic local update first
		db.prepare(`UPDATE messages SET ${col} = ? WHERE id IN (${g.ids.map(() => '?').join(',')})`).run(value ? 1 : 0, ...g.ids);
		if (flag === 'seen') recountUnseen(g.folderId);
		notify(g.accountId, g.folderId);
		await withMailbox(g.accountId, g.path, async (client) => {
			if (value) await client.messageFlagsAdd(g.uids.join(','), [imapFlag], { uid: true });
			else await client.messageFlagsRemove(g.uids.join(','), [imapFlag], { uid: true });
		});
	}
}

function recountUnseen(folderId: number) {
	const db = getDb();
	db.prepare('UPDATE folders SET unseen = (SELECT COUNT(*) FROM messages WHERE folder_id = ? AND seen = 0 AND snoozed_until IS NULL) WHERE id = ?').run(folderId, folderId);
}

/** Move messages to another folder (by role or id). Returns undo info. */
export async function moveMessages(messageIds: number[], target: { role?: string; folderId?: number }): Promise<{ moved: number }> {
	const db = getDb();
	let moved = 0;
	const groups = new Map<string, { accountId: number; folderId: number; path: string; uids: number[]; ids: number[] }>();
	for (const id of messageIds) {
		const m = msg(id);
		if (!m) continue;
		const f = folderById(m.folder_id);
		if (!f) continue;
		const key = `${m.account_id}:${m.folder_id}`;
		if (!groups.has(key)) groups.set(key, { accountId: m.account_id, folderId: m.folder_id, path: f.path, uids: [], ids: [] });
		groups.get(key)!.uids.push(m.uid);
		groups.get(key)!.ids.push(id);
	}
	for (const g of groups.values()) {
		const targetFolder = target.folderId ? folderById(target.folderId) : folderByRole(g.accountId, target.role!);
		if (!targetFolder || targetFolder.id === g.folderId) continue;
		// optimistic: remove locally right away
		db.prepare(`DELETE FROM messages WHERE id IN (${g.ids.map(() => '?').join(',')})`).run(...g.ids);
		db.prepare(`DELETE FROM message_fts WHERE rowid IN (${g.ids.map(() => '?').join(',')})`).run(...g.ids);
		recountUnseen(g.folderId);
		notify(g.accountId, g.folderId);
		await withMailbox(g.accountId, g.path, async (client) => {
			await client.messageMove(g.uids.join(','), targetFolder.path, { uid: true });
		});
		moved += g.ids.length;
	}
	return { moved };
}

export async function deleteMessages(messageIds: number[], permanent = false): Promise<void> {
	const db = getDb();
	const groups = new Map<string, { accountId: number; folderId: number; path: string; role: string | null; uids: number[]; ids: number[] }>();
	for (const id of messageIds) {
		const m = msg(id);
		if (!m) continue;
		const f = folderById(m.folder_id);
		if (!f) continue;
		const key = `${m.account_id}:${m.folder_id}`;
		if (!groups.has(key)) groups.set(key, { accountId: m.account_id, folderId: m.folder_id, path: f.path, role: f.role, uids: [], ids: [] });
		groups.get(key)!.uids.push(m.uid);
		groups.get(key)!.ids.push(id);
	}
	for (const g of groups.values()) {
		db.prepare(`DELETE FROM messages WHERE id IN (${g.ids.map(() => '?').join(',')})`).run(...g.ids);
		db.prepare(`DELETE FROM message_fts WHERE rowid IN (${g.ids.map(() => '?').join(',')})`).run(...g.ids);
		recountUnseen(g.folderId);
		notify(g.accountId, g.folderId);
		if (permanent || g.role === 'trash') {
			await withMailbox(g.accountId, g.path, async (client) => {
				await client.messageDelete(g.uids.join(','), { uid: true });
			});
		} else {
			const trash = folderByRole(g.accountId, 'trash');
			await withMailbox(g.accountId, g.path, async (client) => {
				if (trash) await client.messageMove(g.uids.join(','), trash.path, { uid: true });
				else await client.messageDelete(g.uids.join(','), { uid: true });
			});
		}
	}
}

export async function markSpam(messageIds: number[]): Promise<void> {
	await moveMessages(messageIds, { role: 'junk' });
}

export async function archiveMessages(messageIds: number[]): Promise<void> {
	await moveMessages(messageIds, { role: 'archive' });
}

/** Snooze: mark locally; the message is hidden from the inbox until due, then resurfaces unread-at-top. */
export function snoozeMessages(messageIds: number[], until: number) {
	const db = getDb();
	for (const id of messageIds) {
		const m = msg(id);
		if (!m) continue;
		db.prepare('UPDATE messages SET snoozed_until = ?, snooze_orig_folder = ? WHERE id = ?').run(until, m.folder_id, id);
		recountUnseen(m.folder_id);
		notify(m.account_id, m.folder_id);
	}
}

export function unsnoozeMessages(messageIds: number[]) {
	const db = getDb();
	for (const id of messageIds) {
		const m = msg(id);
		if (!m) continue;
		db.prepare('UPDATE messages SET snoozed_until = NULL, snooze_orig_folder = NULL, seen = 0, internal_date = ? WHERE id = ?').run(Date.now(), id);
		recountUnseen(m.folder_id);
		notify(m.account_id, m.folder_id);
	}
}

/** Wake snoozed messages that are due. Called by the background scheduler. */
export function wakeDueSnoozes(): number {
	const db = getDb();
	const due = db.prepare('SELECT id, account_id, folder_id FROM messages WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?').all(Date.now()) as
		{ id: number; account_id: number; folder_id: number }[];
	for (const d of due) {
		db.prepare('UPDATE messages SET snoozed_until = NULL, snooze_orig_folder = NULL, seen = 0, internal_date = ? WHERE id = ?').run(Date.now(), d.id);
		recountUnseen(d.folder_id);
		notify(d.account_id, d.folder_id);
		publish({ type: 'snooze-wake', data: { messageId: d.id } });
	}
	return due.length;
}
