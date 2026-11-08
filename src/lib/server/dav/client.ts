import { createDAVClient } from 'tsdav';
import type { AccountRow } from '../mail/types';
import { getAccount, getSecret } from '../mail/accounts';

export type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

const clients = new Map<number, Promise<DavClient>>();

export async function getDavClient(accountId: number): Promise<DavClient> {
	let p = clients.get(accountId);
	if (!p) {
		p = (async () => {
			const acc = getAccount(accountId);
			if (!acc) throw new Error('Account not found');
			return buildDavClient(acc);
		})();
		clients.set(accountId, p);
		p.catch(() => clients.delete(accountId));
	}
	return p;
}

export function invalidateDavClient(accountId: number) {
	clients.delete(accountId);
}

async function buildDavClient(acc: AccountRow): Promise<DavClient> {
	return createDAVClient({
		serverUrl: acc.dav_url!,
		credentials: { username: acc.username!, password: getSecret(acc) },
		authMethod: 'Basic',
		defaultAccountType: acc.kind === 'carddav' ? 'carddav' : 'caldav'
	});
}

export async function testDav(opts: {
	url: string;
	username: string;
	password: string;
	kind: 'caldav' | 'carddav';
}): Promise<{ ok: true; collections: number } | { ok: false; error: string }> {
	try {
		const client = await createDAVClient({
			serverUrl: opts.url,
			credentials: { username: opts.username, password: opts.password },
			authMethod: 'Basic',
			defaultAccountType: opts.kind
		});
		const cols = opts.kind === 'caldav' ? await client.fetchCalendars() : await client.fetchAddressBooks();
		return { ok: true, collections: cols.length };
	} catch (err) {
		const e = err as { message?: string; status?: number };
		const msg = e.message ?? String(err);
		if (/401|unauthorized/i.test(msg)) return { ok: false, error: 'Authentication failed — check username/app password.' };
		if (/404|not found/i.test(msg)) return { ok: false, error: 'Server URL not found — check the DAV endpoint.' };
		if (/ENOTFOUND|getaddrinfo/i.test(msg)) return { ok: false, error: 'Host not found — check the server address.' };
		if (/certificate/i.test(msg)) return { ok: false, error: 'TLS certificate error: ' + msg };
		return { ok: false, error: msg };
	}
}
