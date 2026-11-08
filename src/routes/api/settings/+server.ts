import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb, getSetting, setSetting } from '$lib/server/db';
import { changePassword, revokeSession, listSessions } from '$lib/server/auth';
import { listPasskeys, renamePasskey, deletePasskey } from '$lib/server/auth/webauthn';
import { clearCache, cacheTotalSize } from '$lib/server/mail/bodycache';
import { getProfileSetting, setProfileSetting, listProfiles } from '$lib/server/profiles';
import { env } from '$lib/server/env';
import { APP_NAME } from '$lib/config';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const db = getDb();
	const view = url.searchParams.get('view') ?? 'all';

	if (view === 'sessions') {
		return json({ sessions: listSessions(), current: locals.session.id });
	}
	if (view === 'passkeys') {
		return json({ passkeys: listPasskeys() });
	}
	if (view === 'data') {
		return json({ cacheBytes: cacheTotalSize(), cacheMaxMb: env.CACHE_MAX_MB, version: '1.0.0', app: APP_NAME });
	}
	if (view === 'export') {
		// profile config export, excluding secrets
		const profiles = listProfiles().map((p) => ({
			...p,
			settings: getProfileSetting<Record<string, unknown>>(p.id, 'all', {}),
			accounts: db
				.prepare('SELECT kind, name, email, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, dav_url, username FROM accounts WHERE profile_id = ?')
				.all(p.id)
		}));
		const global: Record<string, string> = {};
		for (const k of ['timezone', 'locale', 'week_start', 'date_format', 'time_format', 'default_view', 'density', 'undo_send_seconds', 'shortcuts_enabled']) {
			const v = getSetting(k);
			if (v !== null) global[k] = v;
		}
		return json({ app: APP_NAME, exportedAt: new Date().toISOString(), global, profiles });
	}
	// general settings
	const keys = ['timezone', 'locale', 'week_start', 'date_format', 'time_format', 'default_view', 'density', 'undo_send_seconds', 'shortcuts_enabled', 'reading_pane', 'theme', 'accent_h', 'composer_mode', 'smtp_saves_sent', 'snooze_presets', 'notifications'];
	const settings: Record<string, string | null> = {};
	for (const k of keys) settings[k] = getSetting(k);
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);
	const profileSettings = profileId ? getProfileSetting<Record<string, unknown>>(profileId, 'all', {}) : {};
	return json({ settings, profileSettings });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const body = await request.json();

	switch (body.action) {
		case 'set': {
			for (const [k, v] of Object.entries(body.settings as Record<string, string>)) {
				setSetting(k, String(v));
			}
			return json({ ok: true });
		}
		case 'set-profile': {
			const all = getProfileSetting<Record<string, unknown>>(body.profileId, 'all', {});
			Object.assign(all, body.settings);
			setProfileSetting(body.profileId, 'all', all);
			return json({ ok: true });
		}
		case 'change-password': {
			try {
				await changePassword(body.currentPassword, body.newPassword);
			} catch (e) {
				return json({ ok: false, error: e instanceof Error ? e.message : 'Failed' }, { status: 400 });
			}
			return json({ ok: true });
		}
		case 'revoke-session': {
			revokeSession(body.sessionId);
			return json({ ok: true });
		}
		case 'rename-passkey': {
			renamePasskey(body.passkeyId, body.name);
			return json({ ok: true });
		}
		case 'delete-passkey': {
			deletePasskey(body.passkeyId);
			return json({ ok: true });
		}
		case 'clear-cache': {
			clearCache();
			return json({ ok: true });
		}
		default:
			throw error(400, 'Unknown action');
	}
};
