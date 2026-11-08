import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createTask, toggleTask, updateTask, deleteTask } from '$lib/server/dav/ops';
import { parseTodo } from '$lib/server/dav/ics';
import { parseQuickAdd } from '$lib/server/quickadd';
import { syncCalendars } from '$lib/server/dav/sync';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const db = getDb();
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);
	const view = url.searchParams.get('view') ?? 'tasks';

	if (view === 'lists') {
		const lists = db.prepare(`SELECT c.id, c.name, c.color, a.name account_name FROM calendars c JOIN accounts a ON a.id = c.account_id
			WHERE a.profile_id = ? AND c.supports_vtodo = 1 ORDER BY c.id`).all(profileId);
		return json({ lists });
	}

	const rows = db.prepare(`SELECT co.id, co.calendar_id, co.uid, co.summary, co.due, co.completed, co.status, co.priority, co.parent_uid, co.ics, c.name list_name, c.color
		FROM cal_objects co JOIN calendars c ON c.id = co.calendar_id JOIN accounts a ON a.id = c.account_id
		WHERE a.profile_id = ? AND co.kind = 'vtodo' ORDER BY co.completed, CASE WHEN co.due IS NULL THEN 1 ELSE 0 END, co.due`).all(profileId) as
		{ id: number; calendar_id: number; uid: string; summary: string; due: number | null; completed: number; status: string; priority: number | null; parent_uid: string | null; ics: string; list_name: string; color: string | null }[];

	const tasks = rows.map((r) => {
		const parsed = parseTodo(r.ics);
		return {
			id: r.id,
			calendarId: r.calendar_id,
			uid: r.uid,
			summary: r.summary,
			description: parsed?.description ?? '',
			due: r.due,
			start: parsed?.start ?? null,
			completed: !!r.completed,
			priority: r.priority ?? 0,
			parentUid: r.parent_uid,
			rrule: parsed?.rrule ?? null,
			listName: r.list_name,
			color: r.color
		};
	});
	return json({ tasks });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const body = await request.json();
	const db = getDb();

	try {
		switch (body.action) {
			case 'create': {
				const { uid } = await createTask(body.calendarId, {
					summary: body.summary,
					description: body.description,
					due: body.due ? new Date(body.due) : null,
					start: body.start ? new Date(body.start) : null,
					priority: body.priority,
					parentUid: body.parentUid,
					rrule: body.rrule,
					alarmsMinutes: body.alarms
				});
				return json({ ok: true, uid });
			}
			case 'quick-add': {
				const parsed = parseQuickAdd(body.text);
				if (!parsed.title) return json({ ok: false, error: 'Could not parse a title' }, { status: 400 });
				const { uid } = await createTask(body.calendarId, {
					summary: parsed.title,
					due: parsed.start,
					priority: parsed.priority ?? undefined
				});
				return json({ ok: true, uid });
			}
			case 'toggle': {
				await toggleTask(body.calendarId, body.taskId, body.completed);
				return json({ ok: true });
			}
			case 'update': {
				await updateTask(body.calendarId, body.taskId, {
					summary: body.summary,
					description: body.description,
					due: body.due ? new Date(body.due) : null,
					start: body.start ? new Date(body.start) : null,
					priority: body.priority,
					parentUid: body.parentUid,
					rrule: body.rrule
				});
				return json({ ok: true });
			}
			case 'delete': {
				await deleteTask(body.calendarId, body.taskId);
				return json({ ok: true });
			}
			case 'sync': {
				const accounts = db.prepare("SELECT id FROM accounts WHERE profile_id = ? AND kind = 'caldav'").all(body.profileId) as { id: number }[];
				for (const a of accounts) await syncCalendars(a.id);
				return json({ ok: true });
			}
			default:
				throw error(400, 'Unknown action');
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return json({ ok: false, error: err instanceof Error ? err.message : 'Task action failed' }, { status: 500 });
	}
};
