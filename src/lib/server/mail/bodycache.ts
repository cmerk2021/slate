import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db';
import { env } from '../env';
import { log } from '../log';

/** Size-bounded LRU blob cache on disk under DATA_DIR/cache. */

function pathFor(key: string): string {
	const h = createHash('sha256').update(key).digest('hex');
	return join(env.DATA_DIR, 'cache', h.slice(0, 2), h);
}

export function cacheGet(key: string): Buffer | null {
	const p = pathFor(key);
	if (!existsSync(p)) return null;
	try {
		const buf = readFileSync(p);
		getDb().prepare('UPDATE cache_blobs SET last_used = ? WHERE key = ?').run(Date.now(), key);
		return buf;
	} catch {
		return null;
	}
}

export function cachePut(key: string, data: Buffer) {
	const p = pathFor(key);
	mkdirSync(join(p, '..'), { recursive: true });
	writeFileSync(p, data);
	getDb()
		.prepare('INSERT INTO cache_blobs (key, size, last_used) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET size = ?, last_used = ?')
		.run(key, data.length, Date.now(), data.length, Date.now());
}

export function cacheDelete(key: string) {
	try {
		rmSync(pathFor(key), { force: true });
	} catch { /* ok */ }
	getDb().prepare('DELETE FROM cache_blobs WHERE key = ?').run(key);
}

export function cacheTotalSize(): number {
	return ((getDb().prepare('SELECT COALESCE(SUM(size),0) s FROM cache_blobs').get() as { s: number }).s);
}

export function pruneCache() {
	const maxBytes = env.CACHE_MAX_MB * 1024 * 1024;
	let total = cacheTotalSize();
	if (total <= maxBytes) return;
	const db = getDb();
	const rows = db.prepare('SELECT key, size FROM cache_blobs ORDER BY last_used ASC LIMIT 500').all() as { key: string; size: number }[];
	for (const r of rows) {
		if (total <= maxBytes * 0.9) break;
		cacheDelete(r.key);
		total -= r.size;
	}
	log.info('cache pruned', { totalBytes: total });
}

export function clearCache() {
	const db = getDb();
	const rows = db.prepare('SELECT key FROM cache_blobs').all() as { key: string }[];
	for (const r of rows) {
		try {
			rmSync(pathFor(r.key), { force: true });
		} catch { /* ok */ }
	}
	db.prepare('DELETE FROM cache_blobs').run();
}

export function verifyCacheEntry(key: string): boolean {
	try {
		return statSync(pathFor(key)).isFile();
	} catch {
		return false;
	}
}
