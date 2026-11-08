import { ImapFlow } from 'imapflow';
import type { AccountRow } from './types';
import { getAccount, getSecret, tlsOptions } from './accounts';
import { log } from '../log';
import { publish } from '../events';

interface PoolEntry {
	client: ImapFlow | null;
	connecting: Promise<ImapFlow> | null;
	lastError: string | null;
	state: 'disconnected' | 'connecting' | 'connected' | 'error';
}

const pool = new Map<number, PoolEntry>();

export function connectionState(accountId: number): { state: string; error: string | null } {
	const e = pool.get(accountId);
	return { state: e?.state ?? 'disconnected', error: e?.lastError ?? null };
}

function buildClient(acc: AccountRow): ImapFlow {
	const secure = acc.imap_security === 'tls';
	return new ImapFlow({
		host: acc.imap_host!,
		port: acc.imap_port ?? (secure ? 993 : 143),
		secure,
		...(acc.imap_security === 'starttls' ? { requireTLS: true } : {}),
		...(acc.imap_security === 'none' ? { disableAutoEnable: false } : {}),
		auth: { user: acc.username!, pass: getSecret(acc) },
		logger: false,
		tls: tlsOptions(acc),
		socketTimeout: 5 * 60_000
	});
}

/** Get a connected operational IMAP client for an account (shared, serialized via mailbox locks). */
export async function getImap(accountId: number): Promise<ImapFlow> {
	let entry = pool.get(accountId);
	if (!entry) {
		entry = { client: null, connecting: null, lastError: null, state: 'disconnected' };
		pool.set(accountId, entry);
	}
	if (entry.client && entry.client.usable) return entry.client;
	if (entry.connecting) return entry.connecting;

	const acc = getAccount(accountId);
	if (!acc) throw new Error('Account not found');

	entry.state = 'connecting';
	publish({ type: 'conn', profileId: acc.profile_id, data: { accountId, state: 'connecting' } });
	entry.connecting = (async () => {
		const client = buildClient(acc);
		client.on('error', (err: Error) => {
			log.warn('imap client error', { accountId, error: err.message });
			const e = pool.get(accountId);
			if (e) {
				e.lastError = err.message;
				e.state = 'error';
				if (e.client === client) e.client = null;
			}
			publish({ type: 'conn', profileId: acc.profile_id, data: { accountId, state: 'error', error: err.message } });
		});
		client.on('close', () => {
			const e = pool.get(accountId);
			if (e && e.client === client) {
				e.client = null;
				if (e.state !== 'error') e.state = 'disconnected';
			}
		});
		await client.connect();
		const e = pool.get(accountId)!;
		e.client = client;
		e.state = 'connected';
		e.lastError = null;
		publish({ type: 'conn', profileId: acc.profile_id, data: { accountId, state: 'connected' } });
		return client;
	})();

	try {
		return await entry.connecting;
	} catch (err) {
		entry.state = 'error';
		entry.lastError = err instanceof Error ? err.message : String(err);
		publish({ type: 'conn', profileId: acc.profile_id, data: { accountId, state: 'error', error: entry.lastError } });
		throw err;
	} finally {
		entry.connecting = null;
	}
}

export async function closeImap(accountId: number) {
	const entry = pool.get(accountId);
	if (entry?.client) {
		try {
			await entry.client.logout();
		} catch {
			entry.client?.close();
		}
		entry.client = null;
		entry.state = 'disconnected';
	}
	pool.delete(accountId);
}

export async function closeAllImap() {
	await Promise.allSettled([...pool.keys()].map((id) => closeImap(id)));
}

/** Human-readable connection test, used by the account wizard. */
export async function testImap(opts: {
	host: string;
	port: number;
	security: string;
	username: string;
	password: string;
	allowSelfSigned?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const client = new ImapFlow({
		host: opts.host,
		port: opts.port,
		secure: opts.security === 'tls',
		...(opts.security === 'starttls' ? { requireTLS: true } : {}),
		auth: { user: opts.username, pass: opts.password },
		logger: false,
		tls: opts.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
		connectionTimeout: 15_000,
		greetingTimeout: 15_000
	});
	try {
		await client.connect();
		await client.logout();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: humanImapError(err) };
	} finally {
		try {
			client.close();
		} catch { /* ok */ }
	}
}

export function humanImapError(err: unknown): string {
	const e = err as { code?: string; authenticationFailed?: boolean; message?: string };
	if (e?.authenticationFailed) return 'Authentication failed — check your username and password (Fastmail and many providers require an app password).';
	if (e?.code === 'ENOTFOUND') return 'Host not found — check the server address.';
	if (e?.code === 'ECONNREFUSED') return 'Connection refused — check the port and security settings.';
	if (e?.code === 'ETIMEDOUT' || e?.code === 'ETIMEOUT') return 'Connection timed out — the host may be unreachable or the port blocked.';
	if (e?.message?.includes('certificate')) return `TLS certificate error: ${e.message}. Enable "accept self-signed certificates" only if you trust this server.`;
	return e?.message || 'Unknown connection error';
}
