import { getDb } from '../db';
import { decryptSecret, encryptSecret } from '../crypto';
import type { AccountRow } from './types';

export function getAccount(id: number): AccountRow | null {
	return (getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined) ?? null;
}

export function getAccountsByProfile(profileId: number, kind?: string): AccountRow[] {
	const db = getDb();
	return kind
		? (db.prepare('SELECT * FROM accounts WHERE profile_id = ? AND kind = ? ORDER BY id').all(profileId, kind) as AccountRow[])
		: (db.prepare('SELECT * FROM accounts WHERE profile_id = ? ORDER BY id').all(profileId) as AccountRow[]);
}

export function getAllMailAccounts(): AccountRow[] {
	return getDb().prepare("SELECT * FROM accounts WHERE kind IN ('imap','pop3') ORDER BY id").all() as AccountRow[];
}

export function getSecret(acc: AccountRow): string {
	if (!acc.secret_enc) throw new Error('Account has no stored credential');
	return decryptSecret(acc.secret_enc);
}

export interface NewAccount {
	profileId: number;
	kind: 'imap' | 'pop3' | 'caldav' | 'carddav';
	name: string;
	email?: string;
	imapHost?: string;
	imapPort?: number;
	imapSecurity?: string;
	smtpHost?: string;
	smtpPort?: number;
	smtpSecurity?: string;
	davUrl?: string;
	username: string;
	password: string;
	allowSelfSigned?: boolean;
}

export function createAccount(a: NewAccount): number {
	const db = getDb();
	const res = db
		.prepare(
			`INSERT INTO accounts (profile_id, kind, name, email, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security, dav_url, username, secret_enc, allow_self_signed, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			a.profileId, a.kind, a.name, a.email ?? null,
			a.imapHost ?? null, a.imapPort ?? null, a.imapSecurity ?? null,
			a.smtpHost ?? null, a.smtpPort ?? null, a.smtpSecurity ?? null,
			a.davUrl ?? null, a.username, encryptSecret(a.password),
			a.allowSelfSigned ? 1 : 0, Date.now()
		);
	const id = Number(res.lastInsertRowid);
	if ((a.kind === 'imap' || a.kind === 'pop3') && a.email) {
		db.prepare('INSERT INTO identities (account_id, email, name, is_default) VALUES (?, ?, ?, 1)').run(id, a.email, a.name);
	}
	return id;
}

export function updateAccountSecret(id: number, password: string) {
	getDb().prepare('UPDATE accounts SET secret_enc = ? WHERE id = ?').run(encryptSecret(password), id);
}

export function deleteAccount(id: number) {
	getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

export function tlsOptions(acc: AccountRow) {
	return acc.allow_self_signed ? { rejectUnauthorized: false } : undefined;
}
