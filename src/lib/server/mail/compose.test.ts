import { describe, it, expect } from 'vitest';
import { replySubject, forwardSubject, computeReferences, computeReply, htmlToPlainText } from './compose';

describe('subject prefixing', () => {
	it('adds Re: once', () => {
		expect(replySubject('Hello')).toBe('Re: Hello');
		expect(replySubject('Re: Hello')).toBe('Re: Hello');
		expect(replySubject('RE: re: Hello')).toBe('Re: Hello');
	});
	it('handles localized reply prefixes', () => {
		expect(replySubject('AW: Hallo')).toBe('Re: Hallo');
		expect(replySubject('SV: Hej')).toBe('Re: Hej');
	});
	it('adds Fwd: once', () => {
		expect(forwardSubject('Hello')).toBe('Fwd: Hello');
		expect(forwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
		expect(forwardSubject('FW: Hello')).toBe('Fwd: Hello');
	});
});

describe('references chain', () => {
	it('appends the message id', () => {
		expect(computeReferences('<a@x> <b@x>', '<c@x>')).toBe('<a@x> <b@x> <c@x>');
	});
	it('does not duplicate', () => {
		expect(computeReferences('<a@x>', '<a@x>')).toBe('<a@x>');
	});
	it('trims long chains keeping first and last', () => {
		const refs = Array.from({ length: 15 }, (_, i) => `<m${i}@x>`).join(' ');
		const out = computeReferences(refs, '<new@x>');
		const parts = out.split(' ');
		expect(parts.length).toBe(10);
		expect(parts[0]).toBe('<m0@x>');
		expect(parts[parts.length - 1]).toBe('<new@x>');
	});
});

const base = {
	from: [{ name: 'Alice', address: 'alice@a.com' }],
	to: [{ name: 'Me', address: 'me@me.com' }, { name: 'Bob', address: 'bob@b.com' }],
	cc: [{ name: 'Carol', address: 'carol@c.com' }],
	replyTo: [],
	messageId: '<orig@a.com>',
	references: null,
	ownAddresses: ['me@me.com', 'alias@me.com']
};

describe('computeReply', () => {
	it('reply targets the sender only', () => {
		const r = computeReply(base, 'reply');
		expect(r.to.map((a) => a.address)).toEqual(['alice@a.com']);
		expect(r.cc).toEqual([]);
		expect(r.inReplyTo).toBe('<orig@a.com>');
		expect(r.references).toBe('<orig@a.com>');
	});

	it('honors Reply-To over From', () => {
		const r = computeReply({ ...base, replyTo: [{ name: '', address: 'list@l.com' }] }, 'reply');
		expect(r.to.map((a) => a.address)).toEqual(['list@l.com']);
	});

	it('reply-all includes to+cc but excludes own identities', () => {
		const r = computeReply(base, 'replyAll');
		expect(r.to.map((a) => a.address)).toEqual(['alice@a.com', 'bob@b.com']);
		expect(r.cc.map((a) => a.address)).toEqual(['carol@c.com']);
	});

	it('reply-all honors Mail-Followup-To', () => {
		const r = computeReply({ ...base, mailFollowupTo: [{ name: '', address: 'list@l.com' }] }, 'replyAll');
		expect(r.to.map((a) => a.address)).toEqual(['list@l.com']);
		expect(r.cc).toEqual([]);
	});

	it('replying to your own sent message targets original recipients', () => {
		const r = computeReply({ ...base, from: [{ name: 'Me', address: 'me@me.com' }] }, 'reply');
		expect(r.to.map((a) => a.address)).toEqual(['bob@b.com']);
	});

	it('dedupes case-insensitively', () => {
		const r = computeReply({ ...base, cc: [{ name: '', address: 'ALICE@A.com' }, { name: '', address: 'carol@c.com' }] }, 'replyAll');
		expect(r.cc.map((a) => a.address)).toEqual(['carol@c.com']);
	});
});

describe('htmlToPlainText', () => {
	it('converts basic structure', () => {
		const text = htmlToPlainText('<p>Hello <b>world</b></p><p>Second</p>');
		expect(text).toContain('Hello world');
		expect(text).toContain('Second');
	});
});
