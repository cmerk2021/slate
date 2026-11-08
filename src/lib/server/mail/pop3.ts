import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { simpleParser } from 'mailparser';
import { getDb } from '../db';
import { log } from '../log';
import { publish } from '../events';
import { getAccount, getSecret } from './accounts';
import { cachePut } from './bodycache';
import { computeThreadKey, htmlToText } from './sync';
import type { AccountRow } from './types';

/**
 * Minimal in-house POP3 client. POP3 accounts fetch into the local store:
 * a local Inbox plus local Archive/Trash folders (no server folders).
 */

class Pop3Client {
	private sock!: Socket | TLSSocket;
	private buffer = '';
	private pending: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];

	async connect(host: string, port: number, security: string, allowSelfSigned: boolean): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			if (security === 'tls') {
				this.sock = tlsConnect({ host, port, rejectUnauthorized: !allowSelfSigned }, () => resolve());
			} else {
				this.sock = netConnect({ host, port }, () => resolve());
			}
			this.sock.once('error', onError);
			this.sock.setTimeout(30_000, () => this.sock.destroy(new Error('POP3 timeout')));
		});
		this.sock.on('data', (chunk) => this.onData(chunk.toString('latin1')));
		this.sock.on('error', (err) => this.failAll(err));
		this.sock.on('close', () => this.failAll(new Error('Connection closed')));
		const greeting = await this.readLine();
		if (!greeting.startsWith('+OK')) throw new Error('POP3 greeting failed: ' + greeting);
		if (security === 'starttls') {
			const resp = await this.command('STLS');
			if (!resp.startsWith('+OK')) throw new Error('STLS not supported');
			const plain = this.sock as Socket;
			plain.removeAllListeners('data');
			await new Promise<void>((resolve, reject) => {
				const tls = tlsConnect({ socket: plain, rejectUnauthorized: !allowSelfSigned, servername: host }, () => {
					this.sock = tls;
					tls.on('data', (chunk) => this.onData(chunk.toString('latin1')));
					tls.on('error', (err) => this.failAll(err));
					resolve();
				});
				tls.once('error', reject);
			});
		}
	}

	private onData(s: string) {
		this.buffer += s;
		let idx: number;
		while ((idx = this.buffer.indexOf('\r\n')) >= 0 && this.pending.length > 0) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 2);
			this.pending.shift()!.resolve(line);
		}
	}

	private failAll(err: Error) {
		for (const p of this.pending.splice(0)) p.reject(err);
	}

	private readLine(): Promise<string> {
		const idx = this.buffer.indexOf('\r\n');
		if (idx >= 0) {
			const line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 2);
			return Promise.resolve(line);
		}
		return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
	}

	async command(cmd: string): Promise<string> {
		this.sock.write(cmd + '\r\n');
		return this.readLine();
	}

	/** Multi-line response: reads until a lone "." line, un-stuffing leading dots. */
	async commandMulti(cmd: string): Promise<string> {
		const first = await this.command(cmd);
		if (!first.startsWith('+OK')) throw new Error(`POP3 ${cmd.split(' ')[0]} failed: ${first}`);
		const lines: string[] = [];
		for (;;) {
			const line = await this.readLine();
			if (line === '.') break;
			lines.push(line.startsWith('..') ? line.slice(1) : line);
		}
		return lines.join('\r\n');
	}

	async login(user: string, pass: string) {
		const u = await this.command('USER ' + user);
		if (!u.startsWith('+OK')) throw new Error('POP3 USER rejected');
		const p = await this.command('PASS ' + pass);
		if (!p.startsWith('+OK')) throw new Error('Authentication failed — check username/password.');
	}

	async uidl(): Promise<Map<number, string>> {
		const body = await this.commandMulti('UIDL');
		const map = new Map<number, string>();
		for (const line of body.split('\r\n')) {
			const [num, uid] = line.trim().split(/\s+/);
			if (num && uid) map.set(parseInt(num, 10), uid);
		}
		return map;
	}

	async retr(num: number): Promise<Buffer> {
		return Buffer.from(await this.commandMulti('RETR ' + num), 'latin1');
	}

	async dele(num: number) {
		const r = await this.command('DELE ' + num);
		if (!r.startsWith('+OK')) throw new Error('DELE failed');
	}

	async quit() {
		try {
			await this.command('QUIT');
		} finally {
			this.sock.destroy();
		}
	}
}

function ensureLocalFolders(acc: AccountRow): { inbox: number; archive: number; trash: number } {
	const db = getDb();
	const ensure = (path: string, name: string, role: string, order: number): number => {
		db.prepare('INSERT INTO folders (account_id, path, name, role, sort_order) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, path) DO NOTHING').run(acc.id, path, name, role, order);
		return (db.prepare('SELECT id FROM folders WHERE account_id = ? AND path = ?').get(acc.id, path) as { id: number }).id;
	};
	return {
		inbox: ensure('LOCAL/Inbox', 'Inbox', 'inbox', 0),
		archive: ensure('LOCAL/Archive', 'Archive', 'archive', 3),
		trash: ensure('LOCAL/Trash', 'Trash', 'trash', 5)
	};
}

export async function testPop3(opts: { host: string; port: number; security: string; username: string; password: string; allowSelfSigned?: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
	const client = new Pop3Client();
	try {
		await client.connect(opts.host, opts.port, opts.security, !!opts.allowSelfSigned);
		await client.login(opts.username, opts.password);
		await client.quit();
		return { ok: true };
	} catch (err) {
		const e = err as { code?: string; message?: string };
		if (e.code === 'ENOTFOUND') return { ok: false, error: 'Host not found — check the server address.' };
		if (e.code === 'ECONNREFUSED') return { ok: false, error: 'Connection refused — check the port and security settings.' };
		return { ok: false, error: e.message ?? 'POP3 connection failed' };
	}
}

export async function syncPop3Account(accountId: number): Promise<void> {
	const acc = getAccount(accountId);
	if (!acc || acc.kind !== 'pop3') return;
	const db = getDb();
	const folders = ensureLocalFolders(acc);
	const settings = JSON.parse(acc.settings || '{}') as { leaveOnServer?: boolean };
	const leaveOnServer = settings.leaveOnServer !== false;

	const client = new Pop3Client();
	try {
		await client.connect(acc.imap_host!, acc.imap_port ?? 995, acc.imap_security ?? 'tls', !!acc.allow_self_signed);
		await client.login(acc.username!, getSecret(acc));
		const uidl = await client.uidl();
		const known = new Set(
			(db.prepare('SELECT message_id FROM messages WHERE account_id = ? AND message_id LIKE ?').all(accountId, 'pop3:%') as { message_id: string }[]).map((r) => r.message_id)
		);
		let fetched = 0;
		for (const [num, uid] of uidl) {
			const key = 'pop3:' + uid;
			if (known.has(key)) continue;
			const raw = await client.retr(num);
			const parsed = await simpleParser(raw);
			const nextUid = ((db.prepare('SELECT COALESCE(MAX(uid),0) m FROM messages WHERE account_id = ?').get(accountId) as { m: number }).m) + 1;
			const text = (parsed.text || htmlToText(parsed.html || '')).slice(0, 100_000);
			const addr = (a: typeof parsed.from) => (a ? a.value.map((v) => ({ name: v.name || '', address: v.address || '' })) : []);
			const toList = Array.isArray(parsed.to) ? parsed.to.flatMap((t) => t.value) : (parsed.to?.value ?? []);
			const ccList = Array.isArray(parsed.cc) ? parsed.cc.flatMap((t) => t.value) : (parsed.cc?.value ?? []);
			const refs = Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references ?? null);
			const res = db
				.prepare(`INSERT INTO messages (account_id, folder_id, uid, message_id, in_reply_to, refs, thread_key, subject, from_json, to_json, cc_json, reply_to_json, date, internal_date, seen, flags_json, size, snippet, has_attachments, list_id, list_unsubscribe, body_indexed)
					VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'[]',?,?,?,?,?,1)`)
				.run(
					accountId, folders.inbox, nextUid, key, parsed.inReplyTo ?? null, refs,
					computeThreadKey(parsed.messageId ?? null, parsed.inReplyTo ?? null, refs, parsed.subject ?? ''),
					parsed.subject ?? '',
					JSON.stringify(addr(parsed.from)),
					JSON.stringify(toList.map((v) => ({ name: v.name || '', address: v.address || '' }))),
					JSON.stringify(ccList.map((v) => ({ name: v.name || '', address: v.address || '' }))),
					'[]',
					parsed.date ? parsed.date.getTime() : Date.now(), Date.now(),
					raw.length, text.replace(/\s+/g, ' ').trim().slice(0, 140),
					(parsed.attachments?.length ?? 0) > 0 ? 1 : 0,
					typeof parsed.headers.get('list-id') === 'string' ? (parsed.headers.get('list-id') as string) : null,
					typeof parsed.headers.get('list-unsubscribe') === 'string' ? (parsed.headers.get('list-unsubscribe') as string) : null
				);
			const rowid = Number(res.lastInsertRowid);
			cachePut(`body:${accountId}:${folders.inbox}:${nextUid}`, raw);
			db.prepare('INSERT INTO message_fts (rowid, subject, from_addr, to_addr, body) VALUES (?, ?, ?, ?, ?)').run(
				rowid, parsed.subject ?? '',
				addr(parsed.from).map((a) => `${a.name} ${a.address}`).join(' '),
				toList.map((v) => `${v.name} ${v.address}`).join(' '),
				text
			);
			fetched++;
			if (!leaveOnServer) await client.dele(num);
		}
		await client.quit();
		db.prepare("UPDATE folders SET total = (SELECT COUNT(*) FROM messages WHERE folder_id = folders.id), unseen = (SELECT COUNT(*) FROM messages WHERE folder_id = folders.id AND seen = 0) WHERE account_id = ?").run(accountId);
		if (fetched > 0) {
			publish({ type: 'mail', profileId: acc.profile_id, data: { accountId, folderId: folders.inbox, newMessages: fetched } });
			publish({ type: 'badge', data: {} });
		}
	} catch (err) {
		log.warn('pop3 sync failed', { accountId, error: err instanceof Error ? err.message : String(err) });
	}
}
