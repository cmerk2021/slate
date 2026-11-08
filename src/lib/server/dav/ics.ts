import ICAL from 'ical.js';

/** iCalendar helpers: parsing, recurrence expansion, iMIP. Unit tested. */

export interface Occurrence {
	uid: string;
	recurrenceId: string | null; // ISO string of the occurrence start (for recurring)
	summary: string;
	description: string;
	location: string;
	start: number; // epoch ms
	end: number;
	allDay: boolean;
	status: string;
	attendees: Attendee[];
	organizer: string | null;
	alarms: number[]; // minutes before start
	isRecurring: boolean;
}

export interface Attendee {
	email: string;
	name: string;
	partstat: string;
	role: string;
}

function toMs(t: ICAL.Time): number {
	return t.toJSDate().getTime();
}

function parseAttendees(ev: ICAL.Component): Attendee[] {
	return ev.getAllProperties('attendee').map((p) => {
		const val = String(p.getFirstValue() ?? '');
		return {
			email: val.replace(/^mailto:/i, ''),
			name: (p.getParameter('cn') as string) || '',
			partstat: ((p.getParameter('partstat') as string) || 'NEEDS-ACTION').toUpperCase(),
			role: ((p.getParameter('role') as string) || 'REQ-PARTICIPANT').toUpperCase()
		};
	});
}

function parseAlarms(ev: ICAL.Component): number[] {
	const out: number[] = [];
	for (const alarm of ev.getAllSubcomponents('valarm')) {
		const trigger = alarm.getFirstPropertyValue('trigger');
		if (trigger instanceof ICAL.Duration) {
			out.push(Math.round(-trigger.toSeconds() / 60));
		}
	}
	return out;
}

function vevToBase(vev: ICAL.Component): Omit<Occurrence, 'start' | 'end' | 'recurrenceId' | 'isRecurring'> {
	const org = vev.getFirstPropertyValue('organizer');
	return {
		uid: String(vev.getFirstPropertyValue('uid') ?? ''),
		summary: String(vev.getFirstPropertyValue('summary') ?? ''),
		description: String(vev.getFirstPropertyValue('description') ?? ''),
		location: String(vev.getFirstPropertyValue('location') ?? ''),
		allDay: false,
		status: String(vev.getFirstPropertyValue('status') ?? 'CONFIRMED'),
		attendees: parseAttendees(vev),
		organizer: org ? String(org).replace(/^mailto:/i, '') : null,
		alarms: parseAlarms(vev)
	};
}

/**
 * Expand all occurrences of events in an ICS document within [rangeStart, rangeEnd).
 * Handles RRULE, EXDATE, and RECURRENCE-ID overrides.
 */
export function expandOccurrences(icsText: string, rangeStart: Date, rangeEnd: Date): Occurrence[] {
	const jcal = ICAL.parse(icsText);
	const comp = new ICAL.Component(jcal);
	const vevents = comp.getAllSubcomponents('vevent');
	if (vevents.length === 0) return [];

	const out: Occurrence[] = [];
	const master = vevents.find((v) => !v.getFirstProperty('recurrence-id'));
	const overrides = vevents.filter((v) => v.getFirstProperty('recurrence-id'));

	const overrideMap = new Map<string, ICAL.Component>();
	for (const o of overrides) {
		const rid = o.getFirstPropertyValue('recurrence-id');
		if (rid instanceof ICAL.Time) overrideMap.set(rid.toUnixTime().toString(), o);
	}

	const emit = (vev: ICAL.Component, start: ICAL.Time, recurrenceId: ICAL.Time | null, isRecurring: boolean) => {
		const event = new ICAL.Event(vev);
		const allDay = start.isDate;
		let end: ICAL.Time;
		if (recurrenceId && !vev.getFirstProperty('recurrence-id')) {
			// computed occurrence of master: shift end by duration
			const dur = event.duration;
			end = start.clone();
			end.addDuration(dur);
		} else {
			end = event.endDate ?? start.clone();
		}
		const startMs = toMs(start);
		const endMs = toMs(end);
		if (endMs <= rangeStart.getTime() || startMs >= rangeEnd.getTime()) return;
		out.push({
			...vevToBase(vev),
			start: startMs,
			end: endMs,
			allDay,
			recurrenceId: recurrenceId ? recurrenceId.toString() : null,
			isRecurring
		});
	};

	if (!master) {
		// detached overrides only
		for (const o of overrides) {
			const ev = new ICAL.Event(o);
			emit(o, ev.startDate, o.getFirstPropertyValue('recurrence-id') as ICAL.Time, true);
		}
		return out;
	}

	const masterEvent = new ICAL.Event(master);
	if (!masterEvent.isRecurring()) {
		emit(master, masterEvent.startDate, null, false);
		return out;
	}

	const iter = masterEvent.iterator();
	const rangeEndT = ICAL.Time.fromJSDate(rangeEnd, true);
	let next: ICAL.Time | null;
	let guard = 0;
	while ((next = iter.next()) && guard++ < 5000) {
		if (next.compare(rangeEndT) >= 0) break;
		const key = next.toUnixTime().toString();
		const override = overrideMap.get(key);
		if (override) {
			const oev = new ICAL.Event(override);
			if (String(override.getFirstPropertyValue('status') ?? '').toUpperCase() !== 'CANCELLED') {
				emit(override, oev.startDate, next, true);
			}
			overrideMap.delete(key);
		} else {
			emit(master, next, next, true);
		}
	}
	// overrides whose recurrence-id moved into range even if original time was outside
	for (const o of overrideMap.values()) {
		const oev = new ICAL.Event(o);
		if (String(o.getFirstPropertyValue('status') ?? '').toUpperCase() !== 'CANCELLED') {
			emit(o, oev.startDate, o.getFirstPropertyValue('recurrence-id') as ICAL.Time, true);
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

export interface EventInput {
	uid?: string;
	summary: string;
	description?: string;
	location?: string;
	start: Date;
	end: Date;
	allDay?: boolean;
	rrule?: string; // raw RRULE value e.g. FREQ=WEEKLY;BYDAY=MO
	alarmsMinutes?: number[];
	attendees?: { email: string; name?: string }[];
	organizerEmail?: string;
	organizerName?: string;
	timezone?: string;
}

export function buildEventIcs(input: EventInput): { ics: string; uid: string } {
	const uid = input.uid ?? crypto.randomUUID() + '@slate';
	const cal = new ICAL.Component(['vcalendar', [], []]);
	cal.updatePropertyWithValue('prodid', '-//Slate//EN');
	cal.updatePropertyWithValue('version', '2.0');
	const vev = new ICAL.Component('vevent');
	vev.updatePropertyWithValue('uid', uid);
	vev.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
	vev.updatePropertyWithValue('summary', input.summary);
	if (input.description) vev.updatePropertyWithValue('description', input.description);
	if (input.location) vev.updatePropertyWithValue('location', input.location);

	if (input.allDay) {
		const s = ICAL.Time.fromJSDate(input.start, false);
		s.isDate = true;
		const e = ICAL.Time.fromJSDate(input.end, false);
		e.isDate = true;
		vev.updatePropertyWithValue('dtstart', s);
		vev.updatePropertyWithValue('dtend', e);
	} else {
		vev.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(input.start, true));
		vev.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(input.end, true));
	}
	if (input.rrule) {
		vev.updatePropertyWithValue('rrule', ICAL.Recur.fromString(input.rrule));
	}
	if (input.organizerEmail) {
		const org = vev.updatePropertyWithValue('organizer', 'mailto:' + input.organizerEmail);
		if (input.organizerName) org.setParameter('cn', input.organizerName);
	}
	for (const att of input.attendees ?? []) {
		const p = new ICAL.Property('attendee', vev);
		p.setValue('mailto:' + att.email);
		if (att.name) p.setParameter('cn', att.name);
		p.setParameter('role', 'REQ-PARTICIPANT');
		p.setParameter('partstat', 'NEEDS-ACTION');
		p.setParameter('rsvp', 'TRUE');
		vev.addProperty(p);
	}
	for (const mins of input.alarmsMinutes ?? []) {
		const alarm = new ICAL.Component('valarm');
		alarm.updatePropertyWithValue('action', 'DISPLAY');
		alarm.updatePropertyWithValue('description', input.summary);
		const dur = ICAL.Duration.fromSeconds(-mins * 60);
		alarm.updatePropertyWithValue('trigger', dur);
		vev.addSubcomponent(alarm);
	}
	cal.addSubcomponent(vev);
	return { ics: cal.toString(), uid };
}

// ---------- iMIP ----------

export interface ImipInvite {
	method: 'REQUEST' | 'CANCEL' | 'REPLY';
	uid: string;
	summary: string;
	description: string;
	location: string;
	start: number;
	end: number;
	allDay: boolean;
	organizer: string | null;
	organizerName: string;
	attendees: Attendee[];
	sequence: number;
	rawIcs: string;
}

export function parseImip(icsText: string): ImipInvite | null {
	try {
		const jcal = ICAL.parse(icsText);
		const comp = new ICAL.Component(jcal);
		const method = String(comp.getFirstPropertyValue('method') ?? '').toUpperCase();
		if (!['REQUEST', 'CANCEL', 'REPLY'].includes(method)) return null;
		const vev = comp.getFirstSubcomponent('vevent');
		if (!vev) return null;
		const ev = new ICAL.Event(vev);
		const orgProp = vev.getFirstProperty('organizer');
		const base = vevToBase(vev);
		return {
			method: method as ImipInvite['method'],
			uid: base.uid,
			summary: base.summary,
			description: base.description,
			location: base.location,
			start: ev.startDate ? toMs(ev.startDate) : 0,
			end: ev.endDate ? toMs(ev.endDate) : 0,
			allDay: ev.startDate?.isDate ?? false,
			organizer: base.organizer,
			organizerName: orgProp ? ((orgProp.getParameter('cn') as string) || '') : '',
			attendees: base.attendees,
			sequence: Number(vev.getFirstPropertyValue('sequence') ?? 0),
			rawIcs: icsText
		};
	} catch {
		return null;
	}
}

/** Build the iMIP REPLY ICS for an invite response. */
export function buildImipReply(invite: ImipInvite, attendeeEmail: string, partstat: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED', attendeeName?: string): string {
	const jcal = ICAL.parse(invite.rawIcs);
	const src = new ICAL.Component(jcal);
	const srcVev = src.getFirstSubcomponent('vevent')!;

	const cal = new ICAL.Component(['vcalendar', [], []]);
	cal.updatePropertyWithValue('prodid', '-//Slate//EN');
	cal.updatePropertyWithValue('version', '2.0');
	cal.updatePropertyWithValue('method', 'REPLY');

	const vev = new ICAL.Component('vevent');
	vev.updatePropertyWithValue('uid', invite.uid);
	vev.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
	vev.updatePropertyWithValue('sequence', invite.sequence);
	const dtstart = srcVev.getFirstPropertyValue('dtstart');
	if (dtstart) vev.updatePropertyWithValue('dtstart', dtstart as ICAL.Time);
	if (invite.organizer) vev.updatePropertyWithValue('organizer', 'mailto:' + invite.organizer);
	if (invite.summary) vev.updatePropertyWithValue('summary', invite.summary);
	const att = new ICAL.Property('attendee', vev);
	att.setValue('mailto:' + attendeeEmail);
	att.setParameter('partstat', partstat);
	if (attendeeName) att.setParameter('cn', attendeeName);
	vev.addProperty(att);
	cal.addSubcomponent(vev);
	return cal.toString();
}

/** Update the user's PARTSTAT inside a stored event ICS (used after RSVP). */
export function setPartstat(icsText: string, attendeeEmail: string, partstat: string): string {
	const jcal = ICAL.parse(icsText);
	const comp = new ICAL.Component(jcal);
	for (const vev of comp.getAllSubcomponents('vevent')) {
		for (const p of vev.getAllProperties('attendee')) {
			const val = String(p.getFirstValue() ?? '').replace(/^mailto:/i, '').toLowerCase();
			if (val === attendeeEmail.toLowerCase()) p.setParameter('partstat', partstat);
		}
	}
	return comp.toString();
}

// ---------- VTODO ----------

export interface TodoData {
	uid: string;
	summary: string;
	description: string;
	due: number | null;
	start: number | null;
	completed: boolean;
	completedAt: number | null;
	priority: number; // 0 none, 1-4 high, 5 medium, 6-9 low
	status: string;
	parentUid: string | null;
	rrule: string | null;
}

export function parseTodo(icsText: string): TodoData | null {
	try {
		const comp = new ICAL.Component(ICAL.parse(icsText));
		const vt = comp.getFirstSubcomponent('vtodo');
		if (!vt) return null;
		const due = vt.getFirstPropertyValue('due');
		const dtstart = vt.getFirstPropertyValue('dtstart');
		const completed = vt.getFirstPropertyValue('completed');
		const status = String(vt.getFirstPropertyValue('status') ?? 'NEEDS-ACTION').toUpperCase();
		const related = vt.getFirstProperty('related-to');
		const rrule = vt.getFirstPropertyValue('rrule');
		return {
			uid: String(vt.getFirstPropertyValue('uid') ?? ''),
			summary: String(vt.getFirstPropertyValue('summary') ?? ''),
			description: String(vt.getFirstPropertyValue('description') ?? ''),
			due: due instanceof ICAL.Time ? toMs(due) : null,
			start: dtstart instanceof ICAL.Time ? toMs(dtstart) : null,
			completed: status === 'COMPLETED',
			completedAt: completed instanceof ICAL.Time ? toMs(completed) : null,
			priority: Number(vt.getFirstPropertyValue('priority') ?? 0),
			status,
			parentUid: related ? String(related.getFirstValue()) : null,
			rrule: rrule ? String(rrule) : null
		};
	} catch {
		return null;
	}
}

export interface TodoInput {
	uid?: string;
	summary: string;
	description?: string;
	due?: Date | null;
	start?: Date | null;
	priority?: number;
	parentUid?: string | null;
	rrule?: string | null;
	alarmsMinutes?: number[];
}

export function buildTodoIcs(input: TodoInput): { ics: string; uid: string } {
	const uid = input.uid ?? crypto.randomUUID() + '@slate';
	const cal = new ICAL.Component(['vcalendar', [], []]);
	cal.updatePropertyWithValue('prodid', '-//Slate//EN');
	cal.updatePropertyWithValue('version', '2.0');
	const vt = new ICAL.Component('vtodo');
	vt.updatePropertyWithValue('uid', uid);
	vt.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
	vt.updatePropertyWithValue('summary', input.summary);
	if (input.description) vt.updatePropertyWithValue('description', input.description);
	if (input.due) vt.updatePropertyWithValue('due', ICAL.Time.fromJSDate(input.due, true));
	if (input.start) vt.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(input.start, true));
	if (input.priority) vt.updatePropertyWithValue('priority', input.priority);
	if (input.parentUid) vt.updatePropertyWithValue('related-to', input.parentUid);
	if (input.rrule) vt.updatePropertyWithValue('rrule', ICAL.Recur.fromString(input.rrule));
	for (const mins of input.alarmsMinutes ?? []) {
		const alarm = new ICAL.Component('valarm');
		alarm.updatePropertyWithValue('action', 'DISPLAY');
		alarm.updatePropertyWithValue('description', input.summary);
		alarm.updatePropertyWithValue('trigger', ICAL.Duration.fromSeconds(-mins * 60));
		vt.addSubcomponent(alarm);
	}
	cal.addSubcomponent(vt);
	return { ics: cal.toString(), uid };
}

/** Toggle completion in a VTODO ICS. */
export function setTodoCompleted(icsText: string, completed: boolean): string {
	const comp = new ICAL.Component(ICAL.parse(icsText));
	const vt = comp.getFirstSubcomponent('vtodo');
	if (!vt) return icsText;
	if (completed) {
		vt.updatePropertyWithValue('status', 'COMPLETED');
		vt.updatePropertyWithValue('completed', ICAL.Time.fromJSDate(new Date(), true));
		vt.updatePropertyWithValue('percent-complete', 100);
	} else {
		vt.updatePropertyWithValue('status', 'NEEDS-ACTION');
		vt.removeProperty('completed');
		vt.removeProperty('percent-complete');
	}
	return comp.toString();
}

/** Generic field updates on an existing VEVENT ICS (preserves other properties). */
export function updateEventIcs(icsText: string, updates: Partial<EventInput>): string {
	const comp = new ICAL.Component(ICAL.parse(icsText));
	const vev = comp.getFirstSubcomponent('vevent');
	if (!vev) return icsText;
	if (updates.summary !== undefined) vev.updatePropertyWithValue('summary', updates.summary);
	if (updates.description !== undefined) {
		if (updates.description) vev.updatePropertyWithValue('description', updates.description);
		else vev.removeProperty('description');
	}
	if (updates.location !== undefined) {
		if (updates.location) vev.updatePropertyWithValue('location', updates.location);
		else vev.removeProperty('location');
	}
	if (updates.start && updates.end) {
		if (updates.allDay) {
			const s = ICAL.Time.fromJSDate(updates.start, false); s.isDate = true;
			const e = ICAL.Time.fromJSDate(updates.end, false); e.isDate = true;
			vev.updatePropertyWithValue('dtstart', s);
			vev.updatePropertyWithValue('dtend', e);
		} else {
			vev.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(updates.start, true));
			vev.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(updates.end, true));
		}
	}
	if (updates.rrule !== undefined) {
		if (updates.rrule) vev.updatePropertyWithValue('rrule', ICAL.Recur.fromString(updates.rrule));
		else vev.removeProperty('rrule');
	}
	const seq = Number(vev.getFirstPropertyValue('sequence') ?? 0);
	vev.updatePropertyWithValue('sequence', seq + 1);
	vev.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
	return comp.toString();
}

/** Add an EXDATE (delete "this event" of a recurring series). */
export function addExdate(icsText: string, occurrenceStartMs: number, allDay: boolean): string {
	const comp = new ICAL.Component(ICAL.parse(icsText));
	const vev = comp.getFirstSubcomponent('vevent');
	if (!vev) return icsText;
	const t = ICAL.Time.fromJSDate(new Date(occurrenceStartMs), true);
	if (allDay) t.isDate = true;
	const p = new ICAL.Property('exdate', vev);
	p.setValue(t);
	vev.addProperty(p);
	return comp.toString();
}

/** End a recurring series before a given occurrence ("this and following" delete). */
export function setRruleUntil(icsText: string, beforeMs: number): string {
	const comp = new ICAL.Component(ICAL.parse(icsText));
	const vev = comp.getFirstSubcomponent('vevent');
	if (!vev) return icsText;
	const rruleVal = vev.getFirstPropertyValue('rrule');
	if (!rruleVal) return icsText;
	const recur = typeof rruleVal === 'string' ? ICAL.Recur.fromString(rruleVal) : (rruleVal as ICAL.Recur);
	const until = ICAL.Time.fromJSDate(new Date(beforeMs - 1000), true);
	recur.until = until;
	if (recur.count) recur.count = null as never;
	vev.updatePropertyWithValue('rrule', recur);
	return comp.toString();
}
