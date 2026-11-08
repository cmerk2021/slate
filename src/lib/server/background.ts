import { getDb } from './db';
import { log } from './log';
import { publish } from './events';
import { getImap, closeAllImap } from './mail/pool';
import { syncFolders, syncFolder } from './mail/sync';
import { processOutbox } from './mail/send';
import { wakeDueSnoozes } from './mail/actions';
import { pruneCache } from './mail/bodycache';
import { getAllMailAccounts } from './mail/accounts';
import { syncDavAccount } from './dav/sync';
import { syncPop3Account } from './mail/pop3';

/**
 * Background orchestration: per-account IMAP sync + IDLE loops, outbox sender,
 * snooze scheduler, cache pruning, periodic DAV sync.
 * One failing account must never break the others.
 */

let running = false;
const engines = new Map<number, { stop: () => void }>();
let timers: ReturnType<typeof setInterval>[] = [];

export function startBackground() {
	if (running) return;
	running = true;
	log.info('background services starting');

	timers.push(setInterval(() => void safe(processOutbox)(), 1000));
	timers.push(setInterval(() => safeSync(wakeDueSnoozes), 30_000));
	timers.push(setInterval(() => safeSync(pruneCache), 10 * 60_000));
	timers.push(setInterval(() => reconcileEngines(), 30_000));
	timers.push(
		setInterval(() => {
			const db = getDb();
			const davAccounts = db.prepare("SELECT id FROM accounts WHERE kind IN ('caldav','carddav')").all() as { id: number }[];
			for (const a of davAccounts) void safe(syncDavAccount)(a.id);
			const popAccounts = db.prepare("SELECT id FROM accounts WHERE kind = 'pop3'").all() as { id: number }[];
			for (const a of popAccounts) void safe(syncPop3Account)(a.id);
		}, 5 * 60_000)
	);

	// initial runs
	void safe(processOutbox)();
	safeSync(wakeDueSnoozes);
	reconcileEngines();
	const db = getDb();
	for (const a of db.prepare("SELECT id FROM accounts WHERE kind IN ('caldav','carddav')").all() as { id: number }[]) {
		void safe(syncDavAccount)(a.id);
	}
	for (const a of db.prepare("SELECT id FROM accounts WHERE kind = 'pop3'").all() as { id: number }[]) {
		void safe(syncPop3Account)(a.id);
	}
}

function safe<T extends unknown[]>(fn: (...args: T) => Promise<unknown>) {
	return async (...args: T) => {
		try {
			await fn(...args);
		} catch (err) {
			log.warn('background task error', { fn: fn.name, error: err instanceof Error ? err.message : String(err) });
		}
	};
}

function safeSync(fn: () => unknown) {
	try {
		fn();
	} catch (err) {
		log.warn('background task error', { fn: fn.name, error: String(err) });
	}
}

/** Ensure an engine exists for each IMAP account; stop engines for removed accounts. */
export function reconcileEngines() {
	const accounts = getAllMailAccounts().filter((a) => a.kind === 'imap');
	const ids = new Set(accounts.map((a) => a.id));
	for (const [id, engine] of engines) {
		if (!ids.has(id)) {
			engine.stop();
			engines.delete(id);
		}
	}
	for (const acc of accounts) {
		if (!engines.has(acc.id)) engines.set(acc.id, startEngine(acc.id));
	}
}

function startEngine(accountId: number): { stop: () => void } {
	let stopped = false;
	let idleAbort: (() => void) | null = null;

	const loop = async () => {
		let backoff = 5000;
		while (!stopped) {
			try {
				await syncFolders(accountId);
				const db = getDb();
				const inbox = db.prepare("SELECT id FROM folders WHERE account_id = ? AND role = 'inbox'").get(accountId) as { id: number } | undefined;
				const watched = db.prepare('SELECT id FROM folders WHERE account_id = ? AND (watched = 1 OR role IN (\'inbox\',\'sent\',\'drafts\'))').all(accountId) as { id: number }[];
				for (const f of watched) {
					if (stopped) return;
					await syncFolder(accountId, f.id);
				}
				backoff = 5000;

				// IDLE on inbox; any change triggers resync
				if (inbox && !stopped) {
					const client = await getImap(accountId);
					const db2 = getDb();
					const inboxPath = (db2.prepare('SELECT path FROM folders WHERE id = ?').get(inbox.id) as { path: string }).path;
					const lock = await client.getMailboxLock(inboxPath);
					try {
						const changed = new Promise<void>((resolve) => {
							const onChange = () => {
								cleanup();
								resolve();
							};
							const timer = setTimeout(() => {
								cleanup();
								resolve();
							}, 9 * 60_000); // re-issue IDLE periodically
							const cleanup = () => {
								clearTimeout(timer);
								client.off('exists', onChange);
								client.off('expunge', onChange);
								client.off('flags', onChange);
								client.off('close', onChange);
							};
							idleAbort = () => {
								cleanup();
								resolve();
							};
							client.on('exists', onChange);
							client.on('expunge', onChange);
							client.on('flags', onChange);
							client.on('close', onChange);
						});
						await Promise.race([client.idle(), changed]);
					} finally {
						idleAbort = null;
						try {
							lock.release();
						} catch { /* already released on close */ }
					}
					if (!stopped) await syncFolder(accountId, inbox.id);
				} else {
					await sleep(60_000);
				}
			} catch (err) {
				if (stopped) return;
				log.warn('mail engine error, backing off', { accountId, backoffMs: backoff, error: err instanceof Error ? err.message : String(err) });
				publish({ type: 'conn', data: { accountId, state: 'error', error: err instanceof Error ? err.message : String(err) } });
				await sleep(backoff);
				backoff = Math.min(backoff * 2, 5 * 60_000);
			}
		}
	};

	void loop();
	return {
		stop: () => {
			stopped = true;
			idleAbort?.();
		}
	};
}

function sleep(ms: number) {
	return new Promise<void>((r) => setTimeout(r, ms));
}

export async function stopBackground() {
	running = false;
	for (const t of timers) clearInterval(t);
	timers = [];
	for (const [, e] of engines) e.stop();
	engines.clear();
	await closeAllImap();
	log.info('background services stopped');
}

/** Trigger an immediate sync of one account (e.g. right after adding it). */
export function kickAccount(accountId: number) {
	reconcileEngines();
	void safe(async () => {
		await syncFolders(accountId);
		const db = getDb();
		const folders = db.prepare("SELECT id FROM folders WHERE account_id = ? AND role IN ('inbox','sent','drafts')").all(accountId) as { id: number }[];
		for (const f of folders) await syncFolder(accountId, f.id);
	})();
}
