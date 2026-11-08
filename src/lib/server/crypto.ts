import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env';
import { log } from './log';

let masterKey: Buffer | null = null;

/** Derive the AES-256 master key from APP_SECRET, or an auto-generated key file. */
export function getMasterKey(): Buffer {
	if (masterKey) return masterKey;
	let material: Buffer;
	if (env.APP_SECRET) {
		material = Buffer.from(env.APP_SECRET, 'utf8');
	} else {
		const keyPath = join(env.DATA_DIR, 'secret.key');
		if (existsSync(keyPath)) {
			material = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex');
		} else {
			mkdirSync(env.DATA_DIR, { recursive: true });
			material = randomBytes(32);
			writeFileSync(keyPath, material.toString('hex') + '\n', { mode: 0o600 });
			chmodSync(keyPath, 0o600);
			log.info('APP_SECRET not set; generated key file', { path: keyPath });
		}
	}
	masterKey = Buffer.from(hkdfSync('sha256', material, Buffer.from('slate-v1'), Buffer.from('credential-encryption'), 32));
	return masterKey;
}

/** AES-256-GCM encrypt: returns iv(12) || tag(16) || ciphertext. */
export function encryptSecret(plaintext: string, key = getMasterKey()): Buffer {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer | Uint8Array, key = getMasterKey()): string {
	const buf = Buffer.from(blob);
	if (buf.length < 28) throw new Error('Corrupt encrypted blob');
	const iv = buf.subarray(0, 12);
	const tag = buf.subarray(12, 28);
	const ct = buf.subarray(28);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}
