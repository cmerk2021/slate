import { describe, it, expect } from 'vitest';
import { parseQuickAdd } from './quickadd';

// fixed "now": Wednesday 2024-06-12 10:00 local time
const now = new Date(2024, 5, 12, 10, 0, 0);

describe('parseQuickAdd', () => {
	it('parses "tomorrow 1pm"', () => {
		const r = parseQuickAdd('Lunch with Sam tomorrow 1pm', now);
		expect(r.title).toBe('Lunch with Sam');
		expect(r.start?.getDate()).toBe(13);
		expect(r.start?.getHours()).toBe(13);
		expect(r.allDay).toBe(false);
	});

	it('parses a weekday name as the next occurrence', () => {
		const r = parseQuickAdd('pay rent friday', now);
		expect(r.title).toBe('pay rent');
		expect(r.start?.getDay()).toBe(5);
		expect(r.start!.getTime()).toBeGreaterThan(now.getTime());
		expect(r.allDay).toBe(true);
	});

	it('parses priority markers', () => {
		expect(parseQuickAdd('pay rent friday !high', now).priority).toBe(1);
		expect(parseQuickAdd('water plants !low', now).priority).toBe(9);
		expect(parseQuickAdd('thing !3', now).priority).toBe(3);
	});

	it('parses "today" and times with minutes', () => {
		const r = parseQuickAdd('standup today 9:30am', now);
		expect(r.start?.getDate()).toBe(12);
		expect(r.start?.getHours()).toBe(9);
		expect(r.start?.getMinutes()).toBe(30);
	});

	it('parses time ranges', () => {
		const r = parseQuickAdd('design review tomorrow 1pm-2:30pm', now);
		expect(r.start?.getHours()).toBe(13);
		expect(r.end?.getHours()).toBe(14);
		expect(r.end?.getMinutes()).toBe(30);
	});

	it('returns null date for plain text', () => {
		const r = parseQuickAdd('buy milk', now);
		expect(r.title).toBe('buy milk');
		expect(r.start).toBeNull();
	});
});
