import { describe, it, expect } from 'vitest';
import { parseVcard, buildVcard } from './vcard';

describe('parseVcard', () => {
	it('parses vCard 3.0', () => {
		const v = [
			'BEGIN:VCARD', 'VERSION:3.0', 'UID:abc', 'FN:Jane Doe', 'N:Doe;Jane;;;',
			'EMAIL;TYPE=WORK:jane@work.com', 'EMAIL;TYPE=HOME:jane@home.com',
			'TEL;TYPE=CELL:+1 555 0100', 'ORG:Acme Corp', 'TITLE:Engineer',
			'BDAY:1990-04-01', 'NOTE:Likes tea', 'END:VCARD'
		].join('\r\n');
		const c = parseVcard(v)!;
		expect(c.fn).toBe('Jane Doe');
		expect(c.firstName).toBe('Jane');
		expect(c.lastName).toBe('Doe');
		expect(c.emails.map((e) => e.value)).toEqual(['jane@work.com', 'jane@home.com']);
		expect(c.phones[0].value).toContain('555');
		expect(c.org).toBe('Acme Corp');
		expect(c.bday).toContain('1990');
	});

	it('parses vCard 4.0', () => {
		const v = ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u4', 'FN:Bob', 'EMAIL:bob@b.com', 'END:VCARD'].join('\r\n');
		const c = parseVcard(v)!;
		expect(c.fn).toBe('Bob');
		expect(c.emails[0].value).toBe('bob@b.com');
	});

	it('returns null for garbage', () => {
		expect(parseVcard('nope')).toBeNull();
	});
});

describe('buildVcard', () => {
	it('round-trips through parse', () => {
		const { vcard, uid } = buildVcard({
			firstName: 'Sam', lastName: 'Lee',
			emails: [{ type: 'work', value: 'sam@acme.com' }],
			phones: [{ type: 'cell', value: '+1 555 0101' }],
			addresses: [],
			org: 'Acme', title: '', bday: '', note: 'Friend', photo: '', groups: []
		});
		expect(uid).toBeTruthy();
		const parsed = parseVcard(vcard)!;
		expect(parsed.fn).toContain('Sam');
		expect(parsed.emails[0].value).toBe('sam@acme.com');
		expect(parsed.org).toBe('Acme');
	});
});
