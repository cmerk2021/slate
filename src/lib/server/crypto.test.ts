import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, randomToken, safeEqual } from './crypto';

const key = randomBytes(32);

describe('credential encryption', () => {
	it('round-trips a secret', () => {
		const blob = encryptSecret('hunter2-app-password', key);
		expect(decryptSecret(blob, key)).toBe('hunter2-app-password');
	});

	it('produces different ciphertext for the same plaintext (random IV)', () => {
		const a = encryptSecret('same', key);
		const b = encryptSecret('same', key);
		expect(Buffer.compare(a, b)).not.toBe(0);
	});

	it('handles unicode and empty strings', () => {
		expect(decryptSecret(encryptSecret('pässwörd 🎉', key), key)).toBe('pässwörd 🎉');
		expect(decryptSecret(encryptSecret('', key), key)).toBe('');
	});

	it('fails on tampered ciphertext (GCM auth)', () => {
		const blob = encryptSecret('secret', key);
		blob[blob.length - 1] ^= 0xff;
		expect(() => decryptSecret(blob, key)).toThrow();
	});

	it('fails with the wrong key', () => {
		const blob = encryptSecret('secret', key);
		expect(() => decryptSecret(blob, randomBytes(32))).toThrow();
	});
});

describe('tokens', () => {
	it('randomToken is url-safe and unique', () => {
		const t1 = randomToken();
		const t2 = randomToken();
		expect(t1).not.toBe(t2);
		expect(t1).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('safeEqual compares correctly', () => {
		expect(safeEqual('abc', 'abc')).toBe(true);
		expect(safeEqual('abc', 'abd')).toBe(false);
		expect(safeEqual('abc', 'abcd')).toBe(false);
	});
});
