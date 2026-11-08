import { describe, it, expect } from 'vitest';
import { parseSearchQuery, ftsQuote } from './searchquery';

describe('parseSearchQuery', () => {
	it('parses free text', () => {
		expect(parseSearchQuery('hello world')).toMatchObject({ text: 'hello world' });
	});

	it('parses operators', () => {
		const q = parseSearchQuery('from:alice@a.com to:bob subject:"project x" has:attachment is:unread in:Archive report');
		expect(q.from).toBe('alice@a.com');
		expect(q.to).toBe('bob');
		expect(q.subject).toBe('project x');
		expect(q.hasAttachment).toBe(true);
		expect(q.unread).toBe(true);
		expect(q.inFolder).toBe('Archive');
		expect(q.text).toBe('report');
	});

	it('parses is:starred and is:read', () => {
		expect(parseSearchQuery('is:starred').starred).toBe(true);
		expect(parseSearchQuery('is:read').unread).toBe(false);
	});

	it('parses before/after dates', () => {
		const q = parseSearchQuery('after:2024-01-15 before:2024-02-01');
		expect(q.after?.toISOString().slice(0, 10)).toBe('2024-01-15');
		expect(q.before?.toISOString().slice(0, 10)).toBe('2024-02-01');
	});

	it('ignores invalid dates', () => {
		expect(parseSearchQuery('before:soon').before).toBeUndefined();
	});
});

describe('ftsQuote', () => {
	it('quotes terms as prefix phrases', () => {
		expect(ftsQuote('hello world')).toBe('"hello"* "world"*');
	});
	it('escapes embedded quotes', () => {
		expect(ftsQuote('say "hi"')).toBe('"say"* """hi"""*');
	});
});
