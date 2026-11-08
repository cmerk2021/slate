import { getDb } from './db';

export interface Profile {
	id: number;
	name: string;
	icon: string;
	accent_h: number | null;
	theme: string | null;
	sort_order: number;
	settings: string;
}

export function listProfiles(): Profile[] {
	return getDb().prepare('SELECT * FROM profiles ORDER BY sort_order, id').all() as Profile[];
}

export function getProfile(id: number): Profile | null {
	return (getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id) as Profile | undefined) ?? null;
}

export function createProfile(p: { name: string; icon?: string; accentH?: number | null; theme?: string | null }): number {
	const db = getDb();
	const max = (db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM profiles').get() as { m: number }).m;
	const res = db
		.prepare('INSERT INTO profiles (name, icon, accent_h, theme, sort_order) VALUES (?, ?, ?, ?, ?)')
		.run(p.name, p.icon ?? '🏠', p.accentH ?? null, p.theme ?? null, max + 1);
	return Number(res.lastInsertRowid);
}

export function updateProfile(id: number, p: Partial<{ name: string; icon: string; accent_h: number | null; theme: string | null; sort_order: number; settings: string }>) {
	const db = getDb();
	const fields: string[] = [];
	const vals: unknown[] = [];
	for (const [k, v] of Object.entries(p)) {
		if (['name', 'icon', 'accent_h', 'theme', 'sort_order', 'settings'].includes(k)) {
			fields.push(`${k} = ?`);
			vals.push(v);
		}
	}
	if (fields.length === 0) return;
	vals.push(id);
	db.prepare(`UPDATE profiles SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

export function deleteProfile(id: number) {
	getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

export function getProfileSetting<T>(profileId: number, key: string, fallback: T): T {
	const p = getProfile(profileId);
	if (!p) return fallback;
	try {
		const s = JSON.parse(p.settings) as Record<string, unknown>;
		return (s[key] as T) ?? fallback;
	} catch {
		return fallback;
	}
}

export function setProfileSetting(profileId: number, key: string, value: unknown) {
	const p = getProfile(profileId);
	if (!p) return;
	let s: Record<string, unknown> = {};
	try {
		s = JSON.parse(p.settings);
	} catch { /* reset */ }
	s[key] = value;
	updateProfile(profileId, { settings: JSON.stringify(s) });
}

/** Unread badge counts per profile (sum of inbox unseen across the profile's mail accounts). */
export function profileUnreadCounts(): Record<number, number> {
	const rows = getDb()
		.prepare(`SELECT a.profile_id pid, COALESCE(SUM(f.unseen), 0) unread
			FROM accounts a JOIN folders f ON f.account_id = a.id AND f.role = 'inbox'
			WHERE a.kind IN ('imap','pop3') GROUP BY a.profile_id`)
		.all() as { pid: number; unread: number }[];
	const out: Record<number, number> = {};
	for (const r of rows) out[r.pid] = r.unread;
	return out;
}
