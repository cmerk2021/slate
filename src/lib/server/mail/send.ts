import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer';
import { getDb, getSetting } from '../db';
import { getAccount, getSecret, tlsOptions } from './accounts';
import { getImap } from './pool';
import { folderByRole } from './actions';
import { publish } from '../events';
import { log } from '../log';
import type { AccountRow } from './types';

export function smtpTransport(acc: AccountRow) {
	const secure = acc.smtp_security === 'tls';
	return nodemailer.createTransport({
		host: acc.smtp_host!,
		port: acc.smtp_port ?? (secure ? 465 : 587),
		secure,
		requireTLS: acc.smtp_security === 'starttls',
		auth: { user: acc.username!, pass: getSecret(acc) },
		tls: tlsOptions(acc)
	});
}

export async function testSmtp(opts: {
	host: string; port: number; security: string; username: string; password: string; allowSelfSigned?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const t = nodemailer.createTransport({
		host: opts.host,
		port: opts.port,
		secure: opts.security === 'tls',
		requireTLS: opts.security === 'starttls',
		auth: { user: opts.username, pass: opts.password },
		tls: opts.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
		connectionTimeout: 15_000
	});
	try {
		await t.verify();
		return { ok: true };
	} catch (err) {
		const e = err as { code?: string; responseCode?: number; message?: string };
		if (e.responseCode === 535 || /auth/i.test(e.message ?? '')) return { ok: false, error: 'SMTP authentication failed — check username/app password.' };
		if (e.code === 'ENOTFOUND') return { ok: false, error: 'SMTP host not found.' };
		if (e.code === 'ECONNREFUSED') return { ok: false, error: 'SMTP connection refused — check port/security.' };
		if (e.code === 'ETIMEDOUT') return { ok: false, error: 'SMTP connection timed out.' };
		return { ok: false, error: e.message ?? 'Unknown SMTP error' };
	} finally {
		t.close();
	}
}

export interface OutgoingMessage extends Mail.Options {
	accountId: number;
}

/** Build a raw MIME message buffer. */
export async function buildMime(mail: Mail.Options): Promise<Buffer> {
	const composer = new MailComposer({ ...mail, newline: '\r\n' } as Mail.Options);
	return new Promise((resolve, reject) => {
		composer.compile().build((err, message) => (err ? reject(err) : resolve(message)));
	});
}

/**
 * Queue a message with undo-send delay. Persisted in the outbox table; survives restarts.
 * Returns outbox id for cancel.
 */
export async function queueSend(msg: OutgoingMessage, opts?: { inReplyToMsgDbId?: number; setFlag?: 'answered' | 'forwarded'; delayOverride?: number }): Promise<{ outboxId: number; sendAt: number }> {
	const acc = getAccount(msg.accountId);
	if (!acc) throw new Error('Account not found');
	const delaySec = opts?.delayOverride ?? parseInt(getSetting('undo_send_seconds') ?? '10', 10);
	const mime = await buildMime(msg);
	const envelope = {
		from: typeof msg.from === 'string' ? msg.from.match(/<([^>]+)>/)?.[1] ?? msg.from : (msg.from as { address: string })?.address,
		to: collectAddresses(msg)
	};
	const sendAt = Date.now() + Math.max(0, delaySec) * 1000;
	const res = getDb()
		.prepare('INSERT INTO outbox (account_id, profile_id, mime, envelope_json, send_at, status, created_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
		.run(msg.accountId, acc.profile_id, mime, JSON.stringify(envelope), sendAt, 'queued', Date.now(),
			JSON.stringify({ inReplyToMsgDbId: opts?.inReplyToMsgDbId ?? null, setFlag: opts?.setFlag ?? null, subject: msg.subject ?? '' }));
	const outboxId = Number(res.lastInsertRowid);
	publish({ type: 'outbox', profileId: acc.profile_id, data: { outboxId, status: 'queued', sendAt } });
	return { outboxId, sendAt };
}

function collectAddresses(msg: Mail.Options): string[] {
	const out: string[] = [];
	for (const field of [msg.to, msg.cc, msg.bcc]) {
		if (!field) continue;
		const arr = Array.isArray(field) ? field : [field];
		for (const a of arr) {
			if (typeof a === 'string') {
				for (const part of a.split(',')) {
					const m = part.match(/<([^>]+)>/);
					out.push((m ? m[1] : part).trim());
				}
			} else if (a && typeof a === 'object' && 'address' in a) {
				out.push((a as { address: string }).address);
			}
		}
	}
	return out.filter(Boolean);
}

export function cancelSend(outboxId: number): boolean {
	const db = getDb();
	const res = db.prepare("UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status = 'queued'").run(outboxId);
	return res.changes > 0;
}

/** Process due outbox entries. Called by the background loop every second. */
export async function processOutbox(): Promise<void> {
	const db = getDb();
	const due = db
		.prepare("SELECT id, account_id, profile_id, mime, envelope_json, meta_json FROM outbox WHERE status = 'queued' AND send_at <= ? LIMIT 10")
		.all(Date.now()) as { id: number; account_id: number; profile_id: number; mime: Buffer; envelope_json: string; meta_json: string }[];

	for (const row of due) {
		const claimed = db.prepare("UPDATE outbox SET status = 'sending' WHERE id = ? AND status = 'queued'").run(row.id);
		if (claimed.changes === 0) continue;
		try {
			const acc = getAccount(row.account_id);
			if (!acc) throw new Error('Account deleted');
			const envelope = JSON.parse(row.envelope_json) as { from: string; to: string[] };
			const transport = smtpTransport(acc);
			await transport.sendMail({ envelope, raw: row.mime });
			transport.close();

			// append to Sent unless the server does it (Fastmail does not via SMTP)
			const autoSent = (JSON.parse(acc.settings || '{}') as { smtpSavesSent?: boolean }).smtpSavesSent;
			if (!autoSent) {
				const sent = folderByRole(acc.id, 'sent');
				if (sent) {
					try {
						const client = await getImap(acc.id);
						await client.append(sent.path, row.mime, ['\\Seen']);
					} catch (err) {
						log.warn('append to sent failed', { accountId: acc.id, error: String(err) });
					}
				}
			}

			// set \Answered / $Forwarded on the original
			const meta = JSON.parse(row.meta_json) as { inReplyToMsgDbId: number | null; setFlag: string | null };
			if (meta.inReplyToMsgDbId && meta.setFlag) {
				try {
					const orig = db.prepare('SELECT m.uid, f.path, m.account_id, m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(meta.inReplyToMsgDbId) as
						| { uid: number; path: string; account_id: number; id: number }
						| undefined;
					if (orig) {
						const client = await getImap(orig.account_id);
						const lock = await client.getMailboxLock(orig.path);
						try {
							await client.messageFlagsAdd(String(orig.uid), [meta.setFlag === 'answered' ? '\\Answered' : '$Forwarded'], { uid: true });
						} finally {
							lock.release();
						}
						if (meta.setFlag === 'answered') db.prepare('UPDATE messages SET answered = 1 WHERE id = ?').run(orig.id);
					}
				} catch (err) {
					log.warn('flag original failed', { error: String(err) });
				}
			}

			db.prepare("UPDATE outbox SET status = 'sent', mime = x'' WHERE id = ?").run(row.id);
			publish({ type: 'outbox', profileId: row.profile_id, data: { outboxId: row.id, status: 'sent' } });
			log.info('message sent', { outboxId: row.id, accountId: row.account_id });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			db.prepare("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?").run(msg, row.id);
			publish({ type: 'outbox', profileId: row.profile_id, data: { outboxId: row.id, status: 'failed', error: msg } });
			log.error('send failed', { outboxId: row.id, error: msg });
		}
	}
}

export function retrySend(outboxId: number) {
	getDb().prepare("UPDATE outbox SET status = 'queued', send_at = ?, error = NULL WHERE id = ? AND status = 'failed'").run(Date.now(), outboxId);
}

export function pendingOutbox(profileId: number) {
	return getDb()
		.prepare("SELECT id, account_id, send_at, status, error, meta_json FROM outbox WHERE profile_id = ? AND status IN ('queued','sending','failed') ORDER BY created_at DESC")
		.all(profileId) as { id: number; account_id: number; send_at: number; status: string; error: string | null; meta_json: string }[];
}
