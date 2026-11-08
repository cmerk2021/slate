import {
	generateRegistrationOptions,
	verifyRegistrationResponse,
	generateAuthenticationOptions,
	verifyAuthenticationResponse,
	type RegistrationResponseJSON,
	type AuthenticationResponseJSON
} from '@simplewebauthn/server';
import { getDb } from '../db';
import { env } from '../env';
import { APP_NAME } from '$lib/config';
import { randomToken } from '../crypto';

interface PasskeyRow {
	id: string;
	name: string;
	public_key: Buffer;
	counter: number;
	transports: string | null;
	created_at: number;
	last_used: number | null;
}

function saveChallenge(kind: 'registration' | 'authentication', challenge: string): string {
	const id = randomToken(16);
	const db = getDb();
	db.prepare('DELETE FROM webauthn_challenges WHERE created_at < ?').run(Date.now() - 300_000);
	db.prepare('INSERT INTO webauthn_challenges (id, challenge, kind, created_at) VALUES (?, ?, ?, ?)').run(id, challenge, kind, Date.now());
	return id;
}

function takeChallenge(id: string, kind: string): string | null {
	const db = getDb();
	const row = db.prepare('SELECT challenge, created_at FROM webauthn_challenges WHERE id = ? AND kind = ?').get(id, kind) as
		| { challenge: string; created_at: number }
		| undefined;
	if (row) db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
	if (!row || row.created_at < Date.now() - 300_000) return null;
	return row.challenge;
}

export function listPasskeys() {
	return (getDb().prepare('SELECT id, name, counter, created_at, last_used FROM passkeys ORDER BY created_at').all() as Omit<PasskeyRow, 'public_key' | 'transports'>[]);
}

export function renamePasskey(id: string, name: string) {
	getDb().prepare('UPDATE passkeys SET name = ? WHERE id = ?').run(name.slice(0, 80), id);
}

export function deletePasskey(id: string) {
	getDb().prepare('DELETE FROM passkeys WHERE id = ?').run(id);
}

export function hasPasskeys(): boolean {
	return (getDb().prepare('SELECT COUNT(*) c FROM passkeys').get() as { c: number }).c > 0;
}

export async function startRegistration() {
	const existing = getDb().prepare('SELECT id, transports FROM passkeys').all() as { id: string; transports: string | null }[];
	const options = await generateRegistrationOptions({
		rpName: APP_NAME,
		rpID: env.RP_ID,
		userName: 'owner',
		userDisplayName: `${APP_NAME} owner`,
		attestationType: 'none',
		excludeCredentials: existing.map((c) => ({
			id: c.id,
			transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransport[]) : undefined
		})) as never,
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }
	});
	const challengeId = saveChallenge('registration', options.challenge);
	return { options, challengeId };
}

export async function finishRegistration(challengeId: string, response: RegistrationResponseJSON, name: string) {
	const expectedChallenge = takeChallenge(challengeId, 'registration');
	if (!expectedChallenge) throw new Error('Challenge expired, try again');
	const verification = await verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: env.APP_ORIGIN,
		expectedRPID: env.RP_ID
	});
	if (!verification.verified || !verification.registrationInfo) throw new Error('Passkey verification failed');
	const { credential } = verification.registrationInfo;
	getDb()
		.prepare('INSERT INTO passkeys (id, name, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)')
		.run(
			credential.id,
			name.slice(0, 80) || 'Passkey',
			Buffer.from(credential.publicKey),
			credential.counter,
			JSON.stringify(credential.transports ?? []),
			Date.now()
		);
}

export async function startAuthentication() {
	const options = await generateAuthenticationOptions({
		rpID: env.RP_ID,
		userVerification: 'preferred'
	});
	const challengeId = saveChallenge('authentication', options.challenge);
	return { options, challengeId };
}

export async function finishAuthentication(challengeId: string, response: AuthenticationResponseJSON): Promise<boolean> {
	const expectedChallenge = takeChallenge(challengeId, 'authentication');
	if (!expectedChallenge) throw new Error('Challenge expired, try again');
	const db = getDb();
	const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) as PasskeyRow | undefined;
	if (!row) throw new Error('Unknown passkey');
	const verification = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: env.APP_ORIGIN,
		expectedRPID: env.RP_ID,
		credential: {
			id: row.id,
			publicKey: new Uint8Array(row.public_key),
			counter: row.counter,
			transports: row.transports ? JSON.parse(row.transports) : undefined
		}
	});
	if (!verification.verified) return false;
	db.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').run(
		verification.authenticationInfo.newCounter,
		Date.now(),
		row.id
	);
	return true;
}
