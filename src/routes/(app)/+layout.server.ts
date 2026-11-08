import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getDb, getSetting } from '$lib/server/db';
import { listProfiles, profileUnreadCounts, getProfileSetting } from '$lib/server/profiles';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	if (!locals.session) throw redirect(303, '/login');
	const db = getDb();

	const profiles = listProfiles();
	if (profiles.length === 0) throw redirect(303, '/setup');

	let profileId = parseInt(cookies.get('slate_profile') ?? '0', 10);
	if (!profiles.some((p) => p.id === profileId)) {
		profileId = profiles[0].id;
		cookies.set('slate_profile', String(profileId), { path: '/', httpOnly: false, sameSite: 'lax', maxAge: 365 * 86400 });
	}
	const profile = profiles.find((p) => p.id === profileId)!;

	const accounts = db
		.prepare("SELECT id, kind, name, email FROM accounts WHERE profile_id = ? ORDER BY id")
		.all(profileId) as { id: number; kind: string; name: string; email: string | null }[];

	const mailAccountIds = accounts.filter((a) => a.kind === 'imap' || a.kind === 'pop3').map((a) => a.id);
	const folders = mailAccountIds.length
		? (db
				.prepare(`SELECT id, account_id, path, name, parent_path, role, total, unseen, delimiter FROM folders
					WHERE account_id IN (${mailAccountIds.map(() => '?').join(',')}) ORDER BY account_id, sort_order, path`)
				.all(...mailAccountIds) as {
				id: number; account_id: number; path: string; name: string; parent_path: string | null;
				role: string | null; total: number; unseen: number; delimiter: string | null;
			}[])
		: [];

	const snoozedCount = mailAccountIds.length
		? (db.prepare(`SELECT COUNT(*) c FROM messages WHERE account_id IN (${mailAccountIds.map(() => '?').join(',')}) AND snoozed_until IS NOT NULL`).get(...mailAccountIds) as { c: number }).c
		: 0;

	const settings = {
		timezone: getSetting('timezone') ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		timeFormat: (getSetting('time_format') ?? '12') as '12' | '24',
		weekStart: parseInt(getSetting('week_start') ?? '1', 10),
		density: getSetting('density') ?? 'comfortable',
		defaultView: getSetting('default_view') ?? 'today',
		shortcutsEnabled: getSetting('shortcuts_enabled') !== '0',
		theme: getSetting('theme') ?? 'zen-dark',
		accentH: parseInt(getSetting('accent_h') ?? '18', 10),
		readingPane: getSetting('reading_pane') ?? 'right',
		undoSendSeconds: parseInt(getSetting('undo_send_seconds') ?? '10', 10)
	};

	const profileSettings = getProfileSetting<Record<string, unknown>>(profileId, 'all', {});

	return {
		profiles,
		profile,
		profileUnread: profileUnreadCounts(),
		accounts,
		folders,
		snoozedCount,
		settings,
		profileSettings
	};
};
