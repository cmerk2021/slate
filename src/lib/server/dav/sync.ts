import { getDb } from '../db';
import { log } from '../log';
import { publish } from '../events';
import { getAccount } from '../mail/accounts';
import { getDavClient } from './client';
import { parseTodo } from './ics';
import { parseVcard } from './vcard';
import ICAL from 'ical.js';

/** Sync CalDAV calendars (VEVENT + VTODO) and CardDAV address books into SQLite. */

export async function syncDavAccount(accountId: number): Promise<void> {
	const acc = getAccount(accountId);
	if (!acc) return;
	try {
		if (acc.kind === 'caldav') await syncCalendars(accountId);
		else if (acc.kind === 'carddav') await syncAddressbooks(accountId);
	} catch (err) {
		log.warn('dav sync failed', { accountId, error: err instanceof Error ? err.message : String(err) });
	}
}

export async function syncCalendars(accountId: number): Promise<void> {
	const db = getDb();
	const client = await getDavClient(accountId);
	const calendars = await client.fetchCalendars();
	const acc = getAccount(accountId);

	for (const cal of calendars) {
		const comps = (cal.components ?? []) as string[];
		const supportsEvent = comps.length === 0 || comps.includes('VEVENT');
		const supportsTodo = comps.includes('VTODO');
		if (!supportsEvent && !supportsTodo) continue;
		const name = typeof cal.displayName === 'string' ? cal.displayName : cal.url.split('/').filter(Boolean).pop() ?? 'Calendar';
		db.prepare(
			`INSERT INTO calendars (account_id, url, name, color, supports_vevent, supports_vtodo, ctag)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)
			 ON CONFLICT(account_id, url) DO UPDATE SET name = excluded.name, supports_vevent = excluded.supports_vevent, supports_vtodo = excluded.supports_vtodo`
		).run(accountId, cal.url, name, (cal.calendarColor as string) ?? null, supportsEvent ? 1 : 0, supportsTodo ? 1 : 0);

		const row = db.prepare('SELECT id, ctag FROM calendars WHERE account_id = ? AND url = ?').get(accountId, cal.url) as { id: number; ctag: string | null };
		const newCtag = String(cal.ctag ?? '');
		if (newCtag && row.ctag === newCtag) continue; // unchanged

		const objects = await client.fetchCalendarObjects({ calendar: cal });
		const seen = new Set<string>();
		const upsert = db.prepare(
			`INSERT INTO cal_objects (calendar_id, href, etag, uid, kind, summary, dtstart, dtend, all_day, has_rrule, due, completed, status, priority, parent_uid, ics)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(calendar_id, href) DO UPDATE SET etag=excluded.etag, uid=excluded.uid, kind=excluded.kind, summary=excluded.summary,
				dtstart=excluded.dtstart, dtend=excluded.dtend, all_day=excluded.all_day, has_rrule=excluded.has_rrule, due=excluded.due,
				completed=excluded.completed, status=excluded.status, priority=excluded.priority, parent_uid=excluded.parent_uid, ics=excluded.ics`
		);
		const existingEtags = new Map(
			(db.prepare('SELECT href, etag FROM cal_objects WHERE calendar_id = ?').all(row.id) as { href: string; etag: string }[]).map((r) => [r.href, r.etag])
		);
		for (const obj of objects) {
			if (!obj.data) continue;
			seen.add(obj.url);
			if (existingEtags.get(obj.url) === obj.etag) continue;
			indexObject(upsert, row.id, obj.url, obj.etag ?? '', obj.data);
		}
		const toDelete = [...existingEtags.keys()].filter((href) => !seen.has(href));
		for (const href of toDelete) db.prepare('DELETE FROM cal_objects WHERE calendar_id = ? AND href = ?').run(row.id, href);
		db.prepare('UPDATE calendars SET ctag = ? WHERE id = ?').run(newCtag || null, row.id);
	}
	publish({ type: 'calendar', profileId: acc?.profile_id, data: { accountId } });
}

function indexObject(upsert: { run: (...args: unknown[]) => unknown }, calendarId: number, href: string, etag: string, ics: string) {
	try {
		const comp = new ICAL.Component(ICAL.parse(ics));
		const vev = comp.getFirstSubcomponent('vevent');
		const vtodo = comp.getFirstSubcomponent('vtodo');
		if (vev) {
			const ev = new ICAL.Event(vev);
			// index master range; recurring events get a far-future end so range queries pick them up for expansion
			const hasRrule = ev.isRecurring();
			const start = ev.startDate ? ev.startDate.toJSDate().getTime() : null;
			let end = ev.endDate ? ev.endDate.toJSDate().getTime() : start;
			if (hasRrule) {
				const rrule = vev.getFirstPropertyValue('rrule') as ICAL.Recur | null;
				const until = rrule?.until ? rrule.until.toJSDate().getTime() : null;
				end = until ?? 4102444800000; // 2100-01-01 when unbounded
			}
			upsert.run(calendarId, href, etag, String(vev.getFirstPropertyValue('uid') ?? ''), 'vevent',
				String(vev.getFirstPropertyValue('summary') ?? ''), start, end,
				ev.startDate?.isDate ? 1 : 0, hasRrule ? 1 : 0, null, 0,
				String(vev.getFirstPropertyValue('status') ?? '') || null, null, null, ics);
		} else if (vtodo) {
			const t = parseTodo(ics);
			if (t) {
				upsert.run(calendarId, href, etag, t.uid, 'vtodo', t.summary, t.start, null, 0, t.rrule ? 1 : 0,
					t.due, t.completed ? 1 : 0, t.status, t.priority || null, t.parentUid, ics);
			}
		}
	} catch (err) {
		log.debug('failed to index cal object', { href, error: String(err) });
	}
}

export async function syncAddressbooks(accountId: number): Promise<void> {
	const db = getDb();
	const client = await getDavClient(accountId);
	const books = await client.fetchAddressBooks();
	const acc = getAccount(accountId);

	for (const book of books) {
		const name = typeof book.displayName === 'string' ? book.displayName : 'Contacts';
		db.prepare(
			'INSERT INTO addressbooks (account_id, url, name, ctag) VALUES (?, ?, ?, NULL) ON CONFLICT(account_id, url) DO UPDATE SET name = excluded.name'
		).run(accountId, book.url, name);
		const row = db.prepare('SELECT id, ctag FROM addressbooks WHERE account_id = ? AND url = ?').get(accountId, book.url) as { id: number; ctag: string | null };
		const newCtag = String(book.ctag ?? '');
		if (newCtag && row.ctag === newCtag) continue;

		const vcards = await client.fetchVCards({ addressBook: book });
		const seen = new Set<string>();
		const existingEtags = new Map(
			(db.prepare('SELECT href, etag FROM contacts WHERE addressbook_id = ?').all(row.id) as { href: string; etag: string }[]).map((r) => [r.href, r.etag])
		);
		const upsert = db.prepare(
			`INSERT INTO contacts (addressbook_id, href, etag, uid, fn, emails_json, phones_json, org, bday, note, photo, vcard)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(addressbook_id, href) DO UPDATE SET etag=excluded.etag, uid=excluded.uid, fn=excluded.fn, emails_json=excluded.emails_json,
				phones_json=excluded.phones_json, org=excluded.org, bday=excluded.bday, note=excluded.note, photo=excluded.photo, vcard=excluded.vcard`
		);
		for (const vc of vcards) {
			if (!vc.data) continue;
			seen.add(vc.url);
			if (existingEtags.get(vc.url) === vc.etag) continue;
			const c = parseVcard(vc.data);
			if (!c) continue;
			upsert.run(row.id, vc.url, vc.etag ?? '', c.uid, c.fn, JSON.stringify(c.emails), JSON.stringify(c.phones), c.org || null, c.bday || null, c.note || null, c.photo, vc.data);
		}
		for (const href of [...existingEtags.keys()].filter((h) => !seen.has(h))) {
			db.prepare('DELETE FROM contacts WHERE addressbook_id = ? AND href = ?').run(row.id, href);
		}
		db.prepare('UPDATE addressbooks SET ctag = ? WHERE id = ?').run(newCtag || null, row.id);
	}
	publish({ type: 'contacts', profileId: acc?.profile_id, data: { accountId } });
}
