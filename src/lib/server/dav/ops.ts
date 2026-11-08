import { getDb } from '../db';
import { getDavClient } from './client';
import { publish } from '../events';
import { getAccount } from '../mail/accounts';
import { buildEventIcs, buildTodoIcs, setTodoCompleted, updateEventIcs, addExdate, setRruleUntil, type EventInput, type TodoInput } from './ics';
import { buildVcard, type ContactInput } from './vcard';
import ICAL from 'ical.js';

/** CalDAV/CardDAV write operations with ETag-based conflict handling. */

interface CalRow { id: number; account_id: number; url: string }

function calRow(calendarId: number): CalRow {
	const row = getDb().prepare('SELECT id, account_id, url FROM calendars WHERE id = ?').get(calendarId) as CalRow | undefined;
	if (!row) throw new Error('Calendar not found');
	return row;
}

function notifyCal(accountId: number, type: 'calendar' | 'tasks') {
	const acc = getAccount(accountId);
	publish({ type, profileId: acc?.profile_id, data: { accountId } });
}

export async function createEvent(calendarId: number, input: EventInput): Promise<{ uid: string; ics: string }> {
	const cal = calRow(calendarId);
	const client = await getDavClient(cal.account_id);
	const { ics, uid } = buildEventIcs(input);
	const filename = uid.replace(/[^a-zA-Z0-9@._-]/g, '') + '.ics';
	const res = await client.createCalendarObject({
		calendar: { url: cal.url },
		filename,
		iCalString: ics
	});
	if (!res.ok) throw new Error(`Server rejected the event (HTTP ${res.status})`);
	const href = new URL(res.url || cal.url + filename).pathname;
	getDb()
		.prepare(`INSERT INTO cal_objects (calendar_id, href, etag, uid, kind, summary, dtstart, dtend, all_day, has_rrule, ics)
			VALUES (?, ?, ?, ?, 'vevent', ?, ?, ?, ?, ?, ?)
			ON CONFLICT(calendar_id, href) DO UPDATE SET etag=excluded.etag, ics=excluded.ics`)
		.run(calendarId, href, res.headers?.get('etag') ?? '', uid, input.summary,
			input.start.getTime(), input.rrule ? 4102444800000 : input.end.getTime(),
			input.allDay ? 1 : 0, input.rrule ? 1 : 0, ics);
	notifyCal(cal.account_id, 'calendar');
	return { uid, ics };
}

async function putObject(calendarId: number, objectId: number, newIcs: string): Promise<void> {
	const db = getDb();
	const obj = db.prepare('SELECT href, etag FROM cal_objects WHERE id = ?').get(objectId) as { href: string; etag: string } | undefined;
	if (!obj) throw new Error('Object not found');
	const cal = calRow(calendarId);
	const client = await getDavClient(cal.account_id);
	const base = new URL(cal.url);
	const fullUrl = base.origin + obj.href;
	const res = await client.updateCalendarObject({
		calendarObject: { url: fullUrl, data: newIcs, etag: obj.etag || undefined }
	});
	if (res.status === 412) throw new Error('This item changed on the server. Refresh and try again.');
	if (!res.ok) throw new Error(`Server rejected the update (HTTP ${res.status})`);
	reindex(db, calendarId, obj.href, res.headers?.get('etag') ?? '', newIcs);
}

function reindex(db: ReturnType<typeof getDb>, calendarId: number, href: string, etag: string, ics: string) {
	const comp = new ICAL.Component(ICAL.parse(ics));
	const vev = comp.getFirstSubcomponent('vevent');
	const vtodo = comp.getFirstSubcomponent('vtodo');
	if (vev) {
		const ev = new ICAL.Event(vev);
		const hasRrule = ev.isRecurring();
		const start = ev.startDate ? ev.startDate.toJSDate().getTime() : null;
		let end = ev.endDate ? ev.endDate.toJSDate().getTime() : start;
		if (hasRrule) {
			const rrule = vev.getFirstPropertyValue('rrule') as ICAL.Recur | null;
			end = rrule?.until ? rrule.until.toJSDate().getTime() : 4102444800000;
		}
		db.prepare('UPDATE cal_objects SET etag = ?, ics = ?, summary = ?, dtstart = ?, dtend = ?, all_day = ?, has_rrule = ? WHERE calendar_id = ? AND href = ?')
			.run(etag, ics, String(vev.getFirstPropertyValue('summary') ?? ''), start, end, ev.startDate?.isDate ? 1 : 0, hasRrule ? 1 : 0, calendarId, href);
	} else if (vtodo) {
		const status = String(vtodo.getFirstPropertyValue('status') ?? 'NEEDS-ACTION').toUpperCase();
		const due = vtodo.getFirstPropertyValue('due');
		db.prepare('UPDATE cal_objects SET etag = ?, ics = ?, summary = ?, due = ?, completed = ?, status = ?, priority = ? WHERE calendar_id = ? AND href = ?')
			.run(etag, ics, String(vtodo.getFirstPropertyValue('summary') ?? ''),
				due instanceof ICAL.Time ? due.toJSDate().getTime() : null,
				status === 'COMPLETED' ? 1 : 0, status,
				Number(vtodo.getFirstPropertyValue('priority') ?? 0) || null, calendarId, href);
	}
}

export async function updateEvent(calendarId: number, objectId: number, updates: Partial<EventInput>): Promise<void> {
	const db = getDb();
	const obj = db.prepare('SELECT ics, account_id FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id WHERE co.id = ?').get(objectId) as { ics: string; account_id: number } | undefined;
	if (!obj) throw new Error('Event not found');
	await putObject(calendarId, objectId, updateEventIcs(obj.ics, updates));
	notifyCal(obj.account_id, 'calendar');
}

/** Delete semantics for recurring events: 'one' (EXDATE), 'following' (UNTIL), 'all'. */
export async function deleteEvent(calendarId: number, objectId: number, scope: 'one' | 'following' | 'all', occurrenceStartMs?: number): Promise<void> {
	const db = getDb();
	const obj = db.prepare('SELECT co.href, co.etag, co.ics, co.all_day, c.account_id, c.url as cal_url FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id WHERE co.id = ?').get(objectId) as
		| { href: string; etag: string; ics: string; all_day: number; account_id: number; cal_url: string }
		| undefined;
	if (!obj) throw new Error('Event not found');

	if (scope === 'all' || occurrenceStartMs === undefined) {
		const client = await getDavClient(obj.account_id);
		const base = new URL(obj.cal_url);
		const res = await client.deleteCalendarObject({ calendarObject: { url: base.origin + obj.href, etag: obj.etag || undefined } });
		if (!res.ok && res.status !== 404) throw new Error(`Server rejected the delete (HTTP ${res.status})`);
		db.prepare('DELETE FROM cal_objects WHERE id = ?').run(objectId);
	} else if (scope === 'one') {
		await putObject(calendarId, objectId, addExdate(obj.ics, occurrenceStartMs, !!obj.all_day));
	} else {
		await putObject(calendarId, objectId, setRruleUntil(obj.ics, occurrenceStartMs));
	}
	notifyCal(obj.account_id, 'calendar');
}

/** Edit one occurrence of a recurring event via RECURRENCE-ID override. */
export async function overrideOccurrence(calendarId: number, objectId: number, occurrenceStartMs: number, updates: Partial<EventInput>): Promise<void> {
	const db = getDb();
	const obj = db.prepare('SELECT co.ics, co.all_day, c.account_id FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id WHERE co.id = ?').get(objectId) as
		| { ics: string; all_day: number; account_id: number }
		| undefined;
	if (!obj) throw new Error('Event not found');

	const comp = new ICAL.Component(ICAL.parse(obj.ics));
	const master = comp.getAllSubcomponents('vevent').find((v) => !v.getFirstProperty('recurrence-id'));
	if (!master) throw new Error('No master event');
	const override = new ICAL.Component('vevent');
	override.updatePropertyWithValue('uid', String(master.getFirstPropertyValue('uid')));
	override.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
	const rid = ICAL.Time.fromJSDate(new Date(occurrenceStartMs), true);
	if (obj.all_day) rid.isDate = true;
	override.updatePropertyWithValue('recurrence-id', rid);
	override.updatePropertyWithValue('summary', updates.summary ?? String(master.getFirstPropertyValue('summary') ?? ''));
	if (updates.description) override.updatePropertyWithValue('description', updates.description);
	if (updates.location) override.updatePropertyWithValue('location', updates.location);
	const start = updates.start ?? new Date(occurrenceStartMs);
	const masterEv = new ICAL.Event(master);
	const dur = masterEv.duration;
	const end = updates.end ?? new Date(start.getTime() + dur.toSeconds() * 1000);
	override.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(start, true));
	override.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(end, true));
	comp.addSubcomponent(override);

	await putObject(calendarId, objectId, comp.toString());
	notifyCal(obj.account_id, 'calendar');
}

// ---------- tasks ----------

export async function createTask(calendarId: number, input: TodoInput): Promise<{ uid: string }> {
	const cal = calRow(calendarId);
	const client = await getDavClient(cal.account_id);
	const { ics, uid } = buildTodoIcs(input);
	const filename = uid.replace(/[^a-zA-Z0-9@._-]/g, '') + '.ics';
	const res = await client.createCalendarObject({ calendar: { url: cal.url }, filename, iCalString: ics });
	if (!res.ok) throw new Error(`Server rejected the task (HTTP ${res.status})`);
	const href = new URL(res.url || cal.url + filename).pathname;
	getDb()
		.prepare(`INSERT INTO cal_objects (calendar_id, href, etag, uid, kind, summary, due, completed, status, priority, parent_uid, ics)
			VALUES (?, ?, ?, ?, 'vtodo', ?, ?, 0, 'NEEDS-ACTION', ?, ?, ?)
			ON CONFLICT(calendar_id, href) DO UPDATE SET etag=excluded.etag, ics=excluded.ics`)
		.run(calendarId, href, res.headers?.get('etag') ?? '', uid, input.summary,
			input.due ? input.due.getTime() : null, input.priority || null, input.parentUid ?? null, ics);
	notifyCal(cal.account_id, 'tasks');
	return { uid };
}

export async function toggleTask(calendarId: number, objectId: number, completed: boolean): Promise<void> {
	const db = getDb();
	const obj = db.prepare('SELECT co.ics, c.account_id FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id WHERE co.id = ?').get(objectId) as { ics: string; account_id: number } | undefined;
	if (!obj) throw new Error('Task not found');
	// optimistic local update
	db.prepare('UPDATE cal_objects SET completed = ? WHERE id = ?').run(completed ? 1 : 0, objectId);
	notifyCal(obj.account_id, 'tasks');
	await putObject(calendarId, objectId, setTodoCompleted(obj.ics, completed));
}

export async function updateTask(calendarId: number, objectId: number, input: TodoInput): Promise<void> {
	const db = getDb();
	const obj = db.prepare('SELECT co.ics, co.uid, c.account_id FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id WHERE co.id = ?').get(objectId) as { ics: string; uid: string; account_id: number } | undefined;
	if (!obj) throw new Error('Task not found');
	const { ics } = buildTodoIcs({ ...input, uid: obj.uid });
	await putObject(calendarId, objectId, ics);
	notifyCal(obj.account_id, 'tasks');
}

export async function deleteTask(calendarId: number, objectId: number): Promise<void> {
	const db = getDb();
	const obj = db.prepare('SELECT co.href, co.etag, c.account_id, c.url as cal_url FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id WHERE co.id = ?').get(objectId) as
		| { href: string; etag: string; account_id: number; cal_url: string }
		| undefined;
	if (!obj) throw new Error('Task not found');
	const client = await getDavClient(obj.account_id);
	const base = new URL(obj.cal_url);
	const res = await client.deleteCalendarObject({ calendarObject: { url: base.origin + obj.href, etag: obj.etag || undefined } });
	if (!res.ok && res.status !== 404) throw new Error(`Server rejected the delete (HTTP ${res.status})`);
	db.prepare('DELETE FROM cal_objects WHERE id = ?').run(objectId);
	notifyCal(obj.account_id, 'tasks');
}

// ---------- contacts ----------

export async function createContact(addressbookId: number, input: ContactInput): Promise<{ uid: string }> {
	const db = getDb();
	const book = db.prepare('SELECT id, account_id, url FROM addressbooks WHERE id = ?').get(addressbookId) as { id: number; account_id: number; url: string } | undefined;
	if (!book) throw new Error('Address book not found');
	const client = await getDavClient(book.account_id);
	const { vcard, uid } = buildVcard(input);
	const filename = uid.replace(/[^a-zA-Z0-9@._-]/g, '') + '.vcf';
	const res = await client.createVCard({ addressBook: { url: book.url }, filename, vCardString: vcard });
	if (!res.ok) throw new Error(`Server rejected the contact (HTTP ${res.status})`);
	const href = new URL(res.url || book.url + filename).pathname;
	const c = (await import('./vcard')).parseVcard(vcard)!;
	db.prepare(`INSERT INTO contacts (addressbook_id, href, etag, uid, fn, emails_json, phones_json, org, bday, note, photo, vcard)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(addressbook_id, href) DO UPDATE SET vcard=excluded.vcard, fn=excluded.fn, emails_json=excluded.emails_json`)
		.run(addressbookId, href, res.headers?.get('etag') ?? '', uid, c.fn, JSON.stringify(c.emails), JSON.stringify(c.phones), c.org || null, c.bday || null, c.note || null, c.photo, vcard);
	const acc = getAccount(book.account_id);
	publish({ type: 'contacts', profileId: acc?.profile_id, data: {} });
	return { uid };
}

export async function updateContact(contactId: number, input: ContactInput): Promise<void> {
	const db = getDb();
	const row = db.prepare('SELECT c.href, c.etag, c.uid, b.account_id, b.url as book_url, b.id as book_id FROM contacts c JOIN addressbooks b ON b.id = c.addressbook_id WHERE c.id = ?').get(contactId) as
		| { href: string; etag: string; uid: string; account_id: number; book_url: string; book_id: number }
		| undefined;
	if (!row) throw new Error('Contact not found');
	const client = await getDavClient(row.account_id);
	const { vcard } = buildVcard({ ...input, uid: row.uid });
	const base = new URL(row.book_url);
	const res = await client.updateVCard({ vCard: { url: base.origin + row.href, data: vcard, etag: row.etag || undefined } });
	if (res.status === 412) throw new Error('This contact changed on the server. Refresh and try again.');
	if (!res.ok) throw new Error(`Server rejected the update (HTTP ${res.status})`);
	const c = (await import('./vcard')).parseVcard(vcard)!;
	db.prepare('UPDATE contacts SET etag = ?, vcard = ?, fn = ?, emails_json = ?, phones_json = ?, org = ?, bday = ?, note = ?, photo = ? WHERE id = ?')
		.run(res.headers?.get('etag') ?? '', vcard, c.fn, JSON.stringify(c.emails), JSON.stringify(c.phones), c.org || null, c.bday || null, c.note || null, c.photo, contactId);
	const acc = getAccount(row.account_id);
	publish({ type: 'contacts', profileId: acc?.profile_id, data: {} });
}

export async function deleteContact(contactId: number): Promise<void> {
	const db = getDb();
	const row = db.prepare('SELECT c.href, c.etag, b.account_id, b.url as book_url FROM contacts c JOIN addressbooks b ON b.id = c.addressbook_id WHERE c.id = ?').get(contactId) as
		| { href: string; etag: string; account_id: number; book_url: string }
		| undefined;
	if (!row) throw new Error('Contact not found');
	const client = await getDavClient(row.account_id);
	const base = new URL(row.book_url);
	const res = await client.deleteVCard({ vCard: { url: base.origin + row.href, etag: row.etag || undefined } });
	if (!res.ok && res.status !== 404) throw new Error(`Server rejected the delete (HTTP ${res.status})`);
	db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
	const acc = getAccount(row.account_id);
	publish({ type: 'contacts', profileId: acc?.profile_id, data: {} });
}
