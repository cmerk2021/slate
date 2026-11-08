import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { expandOccurrences, setPartstat, buildImipReply, parseImip } from '$lib/server/dav/ics';
import { createEvent, updateEvent, deleteEvent, overrideOccurrence } from '$lib/server/dav/ops';
import { getDavClient } from '$lib/server/dav/client';
import { syncCalendars } from '$lib/server/dav/sync';
import { parseQuickAdd } from '$lib/server/quickadd';
import { log } from '$lib/server/log';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const db = getDb();
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);
	const view = url.searchParams.get('view') ?? 'events';

	if (view === 'calendars') {
		const calendars = db
			.prepare(`SELECT c.*, a.name account_name FROM calendars c JOIN accounts a ON a.id = c.account_id
				WHERE a.profile_id = ? AND c.supports_vevent = 1 ORDER BY c.id`)
			.all(profileId);
		return json({ calendars });
	}

	if (view === 'events') {
		const start = parseInt(url.searchParams.get('start') ?? '0', 10);
		const end = parseInt(url.searchParams.get('end') ?? '0', 10);
		const rows = db
			.prepare(`SELECT co.id, co.calendar_id, co.ics, co.has_rrule, c.color, c.name cal_name FROM cal_objects co
				JOIN calendars c ON c.id = co.calendar_id
				JOIN accounts a ON a.id = c.account_id
				WHERE a.profile_id = ? AND co.kind = 'vevent' AND c.visible = 1
				AND co.dtstart < ? AND co.dtend > ?`)
			.all(profileId, end, start) as { id: number; calendar_id: number; ics: string; has_rrule: number; color: string | null; cal_name: string }[];
		const events = [];
		for (const r of rows) {
			try {
				const occs = expandOccurrences(r.ics, new Date(start), new Date(end));
				for (const o of occs) {
					events.push({ ...o, objectId: r.id, calendarId: r.calendar_id, color: r.color, calName: r.cal_name });
				}
			} catch (err) {
				log.debug('expand failed', { id: r.id, error: String(err) });
			}
		}
		events.sort((a, b) => a.start - b.start);
		return json({ events });
	}

	throw error(400, 'Unknown view');
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const body = await request.json();
	const db = getDb();

	try {
		switch (body.action) {
			case 'create': {
				const input = {
					summary: body.summary,
					description: body.description,
					location: body.location,
					start: new Date(body.start),
					end: new Date(body.end),
					allDay: body.allDay,
					rrule: body.rrule || undefined,
					alarmsMinutes: body.alarms,
					attendees: body.attendees,
					organizerEmail: body.organizerEmail,
					organizerName: body.organizerName
				};
				const { uid, ics } = await createEvent(body.calendarId, input);
				// return the ics (with METHOD:REQUEST) so the client can email invitations
				const inviteIcs = body.attendees?.length
					? ics.replace(/PRODID:([^\r\n]+)/, 'PRODID:$1\r\nMETHOD:REQUEST')
					: null;
				return json({ ok: true, uid, inviteIcs });
			}
			case 'quick-create': {
				const parsed = parseQuickAdd(body.text);
				if (!parsed.title) return json({ ok: false, error: 'Could not parse a title' }, { status: 400 });
				const start = parsed.start ?? new Date(Date.now() + 3600_000);
				const end = parsed.end ?? new Date(start.getTime() + 3600_000);
				const { uid } = await createEvent(body.calendarId, { summary: parsed.title, start, end, allDay: parsed.allDay });
				return json({ ok: true, uid, parsed: { title: parsed.title, start: start.getTime(), end: end.getTime(), allDay: parsed.allDay } });
			}
			case 'update': {
				if (body.scope === 'one' && body.occurrenceStart) {
					await overrideOccurrence(body.calendarId, body.objectId, body.occurrenceStart, {
						summary: body.summary, description: body.description, location: body.location,
						start: body.start ? new Date(body.start) : undefined,
						end: body.end ? new Date(body.end) : undefined
					});
				} else {
					await updateEvent(body.calendarId, body.objectId, {
						summary: body.summary, description: body.description, location: body.location,
						start: body.start ? new Date(body.start) : undefined,
						end: body.end ? new Date(body.end) : undefined,
						allDay: body.allDay,
						rrule: body.rrule
					});
				}
				return json({ ok: true });
			}
			case 'delete': {
				await deleteEvent(body.calendarId, body.objectId, body.scope ?? 'all', body.occurrenceStart);
				return json({ ok: true });
			}
			case 'toggle-visible': {
				db.prepare('UPDATE calendars SET visible = ? WHERE id = ?').run(body.visible ? 1 : 0, body.calendarId);
				return json({ ok: true });
			}
			case 'set-default': {
				const cal = db.prepare('SELECT account_id FROM calendars WHERE id = ?').get(body.calendarId) as { account_id: number } | undefined;
				if (cal) {
					db.prepare('UPDATE calendars SET is_default = 0 WHERE account_id IN (SELECT id FROM accounts WHERE profile_id = ?)').run(body.profileId);
					db.prepare('UPDATE calendars SET is_default = 1 WHERE id = ?').run(body.calendarId);
				}
				return json({ ok: true });
			}
			case 'set-color': {
				db.prepare('UPDATE calendars SET color = ? WHERE id = ?').run(body.color, body.calendarId);
				return json({ ok: true });
			}
			case 'sync': {
				const accounts = db.prepare("SELECT id FROM accounts WHERE profile_id = ? AND kind = 'caldav'").all(body.profileId) as { id: number }[];
				for (const a of accounts) await syncCalendars(a.id);
				return json({ ok: true });
			}
			case 'rsvp': {
				// Accept/decline an invite: add to default calendar (if accepting) and return iMIP REPLY payload for sending
				const invite = parseImip(body.rawIcs);
				if (!invite) return json({ ok: false, error: 'Invalid invite' }, { status: 400 });
				const replyIcs = buildImipReply(invite, body.attendeeEmail, body.partstat, body.attendeeName);

				if (body.partstat !== 'DECLINED') {
					const defCal = db.prepare(`SELECT c.id, c.url, c.account_id FROM calendars c JOIN accounts a ON a.id = c.account_id
						WHERE a.profile_id = ? AND c.supports_vevent = 1 ORDER BY c.is_default DESC, c.id LIMIT 1`).get(body.profileId) as
						| { id: number; url: string; account_id: number }
						| undefined;
					if (defCal) {
						const stored = setPartstat(
							invite.rawIcs.replace(/METHOD:[^\r\n]+\r?\n/i, ''),
							body.attendeeEmail,
							body.partstat
						);
						const client = await getDavClient(defCal.account_id);
						const filename = invite.uid.replace(/[^a-zA-Z0-9@._-]/g, '') + '.ics';
						const existing = db.prepare('SELECT id, href, etag FROM cal_objects WHERE calendar_id = ? AND uid = ?').get(defCal.id, invite.uid) as { id: number; href: string; etag: string } | undefined;
						if (existing) {
							const base = new URL(defCal.url);
							await client.updateCalendarObject({ calendarObject: { url: base.origin + existing.href, data: stored, etag: existing.etag || undefined } });
							db.prepare('UPDATE cal_objects SET ics = ? WHERE id = ?').run(stored, existing.id);
						} else {
							const res = await client.createCalendarObject({ calendar: { url: defCal.url }, filename, iCalString: stored });
							if (res.ok) {
								const href = new URL(res.url || defCal.url + filename).pathname;
								db.prepare(`INSERT INTO cal_objects (calendar_id, href, etag, uid, kind, summary, dtstart, dtend, all_day, ics)
									VALUES (?, ?, ?, ?, 'vevent', ?, ?, ?, ?, ?) ON CONFLICT(calendar_id, href) DO NOTHING`)
									.run(defCal.id, href, res.headers?.get('etag') ?? '', invite.uid, invite.summary, invite.start, invite.end, invite.allDay ? 1 : 0, stored);
							}
						}
					}
				}
				// conflict detection
				const conflicts = db.prepare(`SELECT co.summary FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id JOIN accounts a ON a.id = c.account_id
					WHERE a.profile_id = ? AND co.kind = 'vevent' AND co.uid != ? AND co.dtstart < ? AND co.dtend > ? LIMIT 3`)
					.all(body.profileId, invite.uid, invite.end, invite.start) as { summary: string }[];
				return json({ ok: true, replyIcs, organizer: invite.organizer, summary: invite.summary, conflicts: conflicts.map((c) => c.summary) });
			}
			default:
				throw error(400, 'Unknown action');
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return json({ ok: false, error: err instanceof Error ? err.message : 'Calendar action failed' }, { status: 500 });
	}
};
