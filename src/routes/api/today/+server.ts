import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { expandOccurrences } from '$lib/server/dav/ics';
import { rowToListItem, type MessageRow } from '$lib/server/mail/types';

/** Today view data: today's events, unread emails, due tasks, snoozed-returning. */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const db = getDb();
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);
	const dayStart = parseInt(url.searchParams.get('dayStart') ?? String(new Date().setHours(0, 0, 0, 0)), 10);
	const dayEnd = dayStart + 86400_000;

	// events
	const evRows = db.prepare(`SELECT co.id, co.calendar_id, co.ics, c.color, c.name cal_name FROM cal_objects co
		JOIN calendars c ON c.id = co.calendar_id JOIN accounts a ON a.id = c.account_id
		WHERE a.profile_id = ? AND co.kind = 'vevent' AND c.visible = 1 AND co.dtstart < ? AND co.dtend > ?`)
		.all(profileId, dayEnd, dayStart) as { id: number; calendar_id: number; ics: string; color: string | null; cal_name: string }[];
	const events = [];
	for (const r of evRows) {
		try {
			for (const o of expandOccurrences(r.ics, new Date(dayStart), new Date(dayEnd))) {
				events.push({ ...o, objectId: r.id, calendarId: r.calendar_id, color: r.color, calName: r.cal_name });
			}
		} catch { /* skip malformed */ }
	}
	events.sort((a, b) => a.start - b.start);

	// unread mail (inbox only)
	const unread = (db.prepare(`SELECT m.* FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'inbox'
		JOIN accounts a ON a.id = m.account_id
		WHERE a.profile_id = ? AND m.seen = 0 AND m.snoozed_until IS NULL
		ORDER BY m.internal_date DESC LIMIT 10`).all(profileId) as MessageRow[]).map(rowToListItem);
	const unreadTotal = (db.prepare(`SELECT COUNT(*) c FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'inbox'
		JOIN accounts a ON a.id = m.account_id WHERE a.profile_id = ? AND m.seen = 0 AND m.snoozed_until IS NULL`).get(profileId) as { c: number }).c;

	// tasks: overdue + due today
	const tasks = db.prepare(`SELECT co.id, co.calendar_id, co.summary, co.due, co.priority, c.color FROM cal_objects co
		JOIN calendars c ON c.id = co.calendar_id JOIN accounts a ON a.id = c.account_id
		WHERE a.profile_id = ? AND co.kind = 'vtodo' AND co.completed = 0 AND co.due IS NOT NULL AND co.due < ?
		ORDER BY co.due LIMIT 20`).all(profileId, dayEnd) as { id: number; calendar_id: number; summary: string; due: number; priority: number | null; color: string | null }[];

	// snoozed returning today
	const snoozed = (db.prepare(`SELECT m.* FROM messages m JOIN accounts a ON a.id = m.account_id
		WHERE a.profile_id = ? AND m.snoozed_until IS NOT NULL AND m.snoozed_until < ? ORDER BY m.snoozed_until LIMIT 10`)
		.all(profileId, dayEnd) as MessageRow[]).map(rowToListItem);

	return json({ events, unread, unreadTotal, tasks, snoozed });
};
