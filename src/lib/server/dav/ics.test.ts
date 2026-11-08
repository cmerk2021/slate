import { describe, it, expect } from 'vitest';
import { expandOccurrences, buildEventIcs, parseImip, buildImipReply, updateEventIcs, addExdate } from './ics';

function wrap(vevent: string, method?: string): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Test//EN',
		...(method ? [`METHOD:${method}`] : []),
		vevent,
		'END:VCALENDAR'
	].join('\r\n');
}

describe('expandOccurrences', () => {
	it('returns a single non-recurring event', () => {
		const ics = wrap(['BEGIN:VEVENT', 'UID:one@x', 'DTSTART:20240610T120000Z', 'DTEND:20240610T130000Z', 'SUMMARY:Lunch', 'END:VEVENT'].join('\r\n'));
		const occ = expandOccurrences(ics, new Date('2024-06-01'), new Date('2024-07-01'));
		expect(occ).toHaveLength(1);
		expect(occ[0].summary).toBe('Lunch');
		expect(occ[0].isRecurring).toBe(false);
	});

	it('expands a daily rule with COUNT', () => {
		const ics = wrap(['BEGIN:VEVENT', 'UID:d@x', 'DTSTART:20240610T090000Z', 'DTEND:20240610T093000Z', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Standup', 'END:VEVENT'].join('\r\n'));
		const occ = expandOccurrences(ics, new Date('2024-06-01'), new Date('2024-07-01'));
		expect(occ).toHaveLength(5);
		expect(new Date(occ[4].start).getUTCDate()).toBe(14);
	});

	it('expands weekly BYDAY within a range window', () => {
		const ics = wrap(['BEGIN:VEVENT', 'UID:w@x', 'DTSTART:20240603T100000Z', 'DTEND:20240603T110000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'SUMMARY:Gym', 'END:VEVENT'].join('\r\n'));
		const occ = expandOccurrences(ics, new Date('2024-06-10T00:00:00Z'), new Date('2024-06-17T00:00:00Z'));
		expect(occ).toHaveLength(2); // Mon 10th + Wed 12th
	});

	it('honors EXDATE', () => {
		const ics = wrap(['BEGIN:VEVENT', 'UID:e@x', 'DTSTART:20240610T090000Z', 'DTEND:20240610T093000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20240611T090000Z', 'SUMMARY:S', 'END:VEVENT'].join('\r\n'));
		const occ = expandOccurrences(ics, new Date('2024-06-01'), new Date('2024-07-01'));
		expect(occ).toHaveLength(2);
	});

	it('applies RECURRENCE-ID overrides', () => {
		const ics = wrap([
			'BEGIN:VEVENT', 'UID:o@x', 'DTSTART:20240610T090000Z', 'DTEND:20240610T093000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Original', 'END:VEVENT',
			'BEGIN:VEVENT', 'UID:o@x', 'RECURRENCE-ID:20240611T090000Z', 'DTSTART:20240611T140000Z', 'DTEND:20240611T143000Z', 'SUMMARY:Moved', 'END:VEVENT'
		].join('\r\n'));
		const occ = expandOccurrences(ics, new Date('2024-06-01'), new Date('2024-07-01'));
		expect(occ).toHaveLength(3);
		const moved = occ.find((o) => o.summary === 'Moved');
		expect(moved).toBeTruthy();
		expect(new Date(moved!.start).getUTCHours()).toBe(14);
	});
});

describe('buildEventIcs / updateEventIcs', () => {
	it('builds a valid VEVENT with rrule and alarm', () => {
		const { ics, uid } = buildEventIcs({
			summary: 'Weekly sync',
			start: new Date('2024-06-10T10:00:00Z'),
			end: new Date('2024-06-10T10:30:00Z'),
			rrule: 'FREQ=WEEKLY;BYDAY=MO',
			alarmsMinutes: [10],
			attendees: [{ email: 'bob@b.com', name: 'Bob' }],
			organizerEmail: 'me@me.com'
		});
		const unfolded = ics.replace(/\r\n[ \t]/g, '');
		expect(uid).toContain('@slate');
		expect(unfolded).toContain('SUMMARY:Weekly sync');
		expect(unfolded).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
		expect(unfolded).toContain('BEGIN:VALARM');
		expect(unfolded).toContain('mailto:bob@b.com');
		expect(unfolded).toContain('ORGANIZER');
		// round-trips through the expander
		const occ = expandOccurrences(ics, new Date('2024-06-01'), new Date('2024-06-25'));
		expect(occ.length).toBe(3);
		expect(occ[0].alarms).toEqual([10]);
	});

	it('updates summary while preserving rrule', () => {
		const { ics } = buildEventIcs({ summary: 'Old', start: new Date('2024-06-10T10:00:00Z'), end: new Date('2024-06-10T11:00:00Z'), rrule: 'FREQ=DAILY;COUNT=2' });
		const updated = updateEventIcs(ics, { summary: 'New' });
		expect(updated).toContain('SUMMARY:New');
		expect(updated).toContain('RRULE:FREQ=DAILY;COUNT=2');
	});

	it('addExdate removes one occurrence', () => {
		const { ics } = buildEventIcs({ summary: 'S', start: new Date('2024-06-10T09:00:00Z'), end: new Date('2024-06-10T09:30:00Z'), rrule: 'FREQ=DAILY;COUNT=3' });
		const withEx = addExdate(ics, new Date('2024-06-11T09:00:00Z').getTime(), false);
		const occ = expandOccurrences(withEx, new Date('2024-06-01'), new Date('2024-07-01'));
		expect(occ).toHaveLength(2);
	});
});

describe('iMIP', () => {
	const invite = wrap(
		['BEGIN:VEVENT', 'UID:inv@x', 'DTSTAMP:20240601T000000Z', 'DTSTART:20240620T150000Z', 'DTEND:20240620T160000Z',
			'SUMMARY:Project kickoff', 'LOCATION:Room 4', 'ORGANIZER;CN=Alice:mailto:alice@a.com',
			'ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@me.com', 'SEQUENCE:2', 'END:VEVENT'].join('\r\n'),
		'REQUEST'
	);

	it('parses a REQUEST', () => {
		const p = parseImip(invite);
		expect(p).toBeTruthy();
		expect(p!.method).toBe('REQUEST');
		expect(p!.summary).toBe('Project kickoff');
		expect(p!.organizer).toBe('alice@a.com');
		expect(p!.organizerName).toBe('Alice');
		expect(p!.attendees.map((a) => a.email)).toContain('me@me.com');
		expect(p!.sequence).toBe(2);
	});

	it('returns null for non-iMIP calendars', () => {
		const plain = wrap(['BEGIN:VEVENT', 'UID:x@x', 'DTSTART:20240620T150000Z', 'DTEND:20240620T160000Z', 'SUMMARY:S', 'END:VEVENT'].join('\r\n'));
		expect(parseImip(plain)).toBeNull();
		expect(parseImip('not ics at all')).toBeNull();
	});

	it('builds a REPLY with the right partstat and sequence', () => {
		const p = parseImip(invite)!;
		const reply = buildImipReply(p, 'me@me.com', 'ACCEPTED', 'Me');
		expect(reply).toContain('METHOD:REPLY');
		expect(reply).toContain('UID:inv@x');
		expect(reply).toContain('PARTSTAT=ACCEPTED');
		expect(reply).toContain('mailto:me@me.com');
		expect(reply).toContain('SEQUENCE:2');
		expect(reply).toContain('ORGANIZER:mailto:alice@a.com');
	});
});
