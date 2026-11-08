import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createAccount, deleteAccount, getAccount, updateAccountSecret } from '$lib/server/mail/accounts';
import { testImap } from '$lib/server/mail/pool';
import { testSmtp } from '$lib/server/mail/send';
import { testPop3 } from '$lib/server/mail/pop3';
import { testDav } from '$lib/server/dav/client';
import { PRESETS, autodiscover } from '$lib/server/mail/presets';
import { kickAccount, reconcileEngines } from '$lib/server/background';
import { syncDavAccount } from '$lib/server/dav/sync';
import { syncPop3Account } from '$lib/server/mail/pop3';
import { log } from '$lib/server/log';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);
	const db = getDb();
	const accounts = db
		.prepare('SELECT id, profile_id, kind, name, email, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, dav_url, username, allow_self_signed, created_at FROM accounts WHERE profile_id = ? ORDER BY id')
		.all(profileId);
	const identities = db
		.prepare('SELECT i.* FROM identities i JOIN accounts a ON a.id = i.account_id WHERE a.profile_id = ?')
		.all(profileId);
	return json({ accounts, identities, presets: PRESETS });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const body = await request.json();
	const action = body.action as string;
	const db = getDb();

	try {
		switch (action) {
			case 'autodiscover': {
				const found = await autodiscover(body.email);
				return json({ found });
			}
			case 'test': {
				const results: Record<string, { ok: boolean; error?: string }> = {};
				if (body.kind === 'imap') {
					results.imap = await testImap({ host: body.imapHost, port: body.imapPort, security: body.imapSecurity, username: body.username, password: body.password, allowSelfSigned: body.allowSelfSigned });
					results.smtp = await testSmtp({ host: body.smtpHost, port: body.smtpPort, security: body.smtpSecurity, username: body.username, password: body.password, allowSelfSigned: body.allowSelfSigned });
				} else if (body.kind === 'pop3') {
					results.pop3 = await testPop3({ host: body.imapHost, port: body.imapPort, security: body.imapSecurity, username: body.username, password: body.password, allowSelfSigned: body.allowSelfSigned });
					results.smtp = await testSmtp({ host: body.smtpHost, port: body.smtpPort, security: body.smtpSecurity, username: body.username, password: body.password, allowSelfSigned: body.allowSelfSigned });
				} else {
					results.dav = await testDav({ url: body.davUrl, username: body.username, password: body.password, kind: body.kind });
				}
				const ok = Object.values(results).every((r) => r.ok);
				return json({ ok, results });
			}
			case 'create': {
				const id = createAccount({
					profileId: body.profileId,
					kind: body.kind,
					name: body.name,
					email: body.email,
					imapHost: body.imapHost, imapPort: body.imapPort, imapSecurity: body.imapSecurity,
					smtpHost: body.smtpHost, smtpPort: body.smtpPort, smtpSecurity: body.smtpSecurity,
					davUrl: body.davUrl,
					username: body.username,
					password: body.password,
					allowSelfSigned: body.allowSelfSigned
				});
				if (body.kind === 'imap') kickAccount(id);
				else if (body.kind === 'pop3') void syncPop3Account(id).catch((e) => log.warn('initial pop3 sync failed', { error: String(e) }));
				else void syncDavAccount(id).catch((e) => log.warn('initial dav sync failed', { error: String(e) }));
				return json({ ok: true, accountId: id });
			}
			case 'update-password': {
				const acc = getAccount(body.accountId);
				if (!acc) throw error(404, 'Account not found');
				updateAccountSecret(body.accountId, body.password);
				return json({ ok: true });
			}
			case 'delete': {
				deleteAccount(body.accountId);
				reconcileEngines();
				return json({ ok: true });
			}
			case 'add-identity': {
				db.prepare('INSERT INTO identities (account_id, email, name, signature_html, is_default) VALUES (?, ?, ?, ?, 0)').run(body.accountId, body.email, body.name ?? '', body.signatureHtml ?? '');
				return json({ ok: true });
			}
			case 'update-identity': {
				db.prepare('UPDATE identities SET email = ?, name = ?, signature_html = ? WHERE id = ?').run(body.email, body.name ?? '', body.signatureHtml ?? '', body.identityId);
				return json({ ok: true });
			}
			case 'delete-identity': {
				db.prepare('DELETE FROM identities WHERE id = ?').run(body.identityId);
				return json({ ok: true });
			}
			case 'set-default-identity': {
				const ident = db.prepare('SELECT account_id FROM identities WHERE id = ?').get(body.identityId) as { account_id: number } | undefined;
				if (ident) {
					db.prepare('UPDATE identities SET is_default = 0 WHERE account_id = ?').run(ident.account_id);
					db.prepare('UPDATE identities SET is_default = 1 WHERE id = ?').run(body.identityId);
				}
				return json({ ok: true });
			}
			default:
				throw error(400, 'Unknown action');
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return json({ ok: false, error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
	}
};
