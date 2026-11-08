import argon2 from 'argon2';
import { getDb, getSetting, setSetting } from '../db';
import { randomToken } from '../crypto';
import { env } from '../env';

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 };

export function isSetupDone(): boolean {
	return getSetting('password_hash') !== null;
}

export async function setupPassword(password: string) {
	if (isSetupDone()) throw new Error('Setup already completed');
	if (password.length < 12) throw new Error('Password must be at least 12 characters');
	setSetting('password_hash', await argon2.hash(password, ARGON_OPTS));
}

export async function verifyPassword(password: string): Promise<boolean> {
	const hash = getSetting('password_hash');
	if (!hash) return false;
	try {
		return await argon2.verify(hash, password);
	} catch {
		return false;
	}
}

export async function changePassword(current: string, next: string) {
	if (!(await verifyPassword(current))) throw new Error('Current password is incorrect');
	if (next.length < 12) throw new Error('Password must be at least 12 characters');
	setSetting('password_hash', await argon2.hash(next, ARGON_OPTS));
}

// ---- sessions ----

export interface Session {
	id: string;
	createdAt: number;
}

export function createSession(ip?: string, userAgent?: string): string {
	const id = randomToken(32);
	const now = Date.now();
	const days = parseInt(getSetting('session_days') ?? '', 10) || env.SESSION_DAYS;
	getDb()
		.prepare('INSERT INTO sessions (id, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, now, now, now + days * 86400_000, ip ?? null, (userAgent ?? '').slice(0, 300));
	return id;
}

export function validateSession(id: string | undefined): Session | null {
	if (!id || id.length < 20) return null;
	const db = getDb();
	const row = db.prepare('SELECT id, created_at, expires_at, last_seen FROM sessions WHERE id = ?').get(id) as
		| { id: string; created_at: number; expires_at: number; last_seen: number }
		| undefined;
	const now = Date.now();
	if (!row) return null;
	if (row.expires_at < now) {
		db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
		return null;
	}
	// sliding expiry: refresh at most every 10 minutes
	if (now - row.last_seen > 600_000) {
		const days = parseInt(getSetting('session_days') ?? '', 10) || env.SESSION_DAYS;
		db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?').run(now, now + days * 86400_000, id);
	}
	return { id: row.id, createdAt: row.created_at };
}

export function revokeSession(id: string) {
	getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function listSessions() {
	return getDb()
		.prepare('SELECT id, created_at, last_seen, expires_at, ip, user_agent FROM sessions ORDER BY last_seen DESC')
		.all() as { id: string; created_at: number; last_seen: number; expires_at: number; ip: string | null; user_agent: string | null }[];
}

// ---- rate limiting with exponential backoff ----

const MAX_FAILS_BEFORE_LOCK = 5;

export function checkRateLimit(key: string): { allowed: boolean; retryAfterMs: number } {
	const row = getDb().prepare('SELECT fails, locked_until FROM rate_limits WHERE key = ?').get(key) as
		| { fails: number; locked_until: number }
		| undefined;
	if (!row) return { allowed: true, retryAfterMs: 0 };
	const now = Date.now();
	if (row.locked_until > now) return { allowed: false, retryAfterMs: row.locked_until - now };
	return { allowed: true, retryAfterMs: 0 };
}

export function recordFailure(key: string) {
	const db = getDb();
	const now = Date.now();
	const row = db.prepare('SELECT fails FROM rate_limits WHERE key = ?').get(key) as { fails: number } | undefined;
	const fails = (row?.fails ?? 0) + 1;
	let lockedUntil = 0;
	if (fails >= MAX_FAILS_BEFORE_LOCK) {
		const backoff = Math.min(2 ** (fails - MAX_FAILS_BEFORE_LOCK) * 30_000, 3600_000);
		lockedUntil = now + backoff;
	}
	db.prepare(
		'INSERT INTO rate_limits (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET fails = ?, locked_until = ?, updated_at = ?'
	).run(key, fails, lockedUntil, now, fails, lockedUntil, now);
}

export function recordSuccess(key: string) {
	getDb().prepare('DELETE FROM rate_limits WHERE key = ?').run(key);
}
