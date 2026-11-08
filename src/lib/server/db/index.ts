import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env';
import { log } from '../log';
import { MIGRATIONS } from './migrations';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (db) return db;
	mkdirSync(env.DATA_DIR, { recursive: true });
	mkdirSync(join(env.DATA_DIR, 'cache'), { recursive: true });
	db = new Database(join(env.DATA_DIR, 'slate.db'));
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('foreign_keys = ON');
	db.pragma('busy_timeout = 5000');
	migrate(db);
	return db;
}

function migrate(d: Database.Database) {
	d.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
	const applied = new Set(
		(d.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version)
	);
	for (const m of MIGRATIONS) {
		if (applied.has(m.version)) continue;
		const run = d.transaction(() => {
			d.exec(m.sql);
			d.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
		});
		run();
		log.info('migration applied', { version: m.version });
	}
}

export function closeDb() {
	if (db) {
		try {
			db.pragma('wal_checkpoint(TRUNCATE)');
		} catch { /* best effort */ }
		db.close();
		db = null;
	}
}

/** App-level key/value settings. */
export function getSetting(key: string): string | null {
	const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
	return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
	getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
