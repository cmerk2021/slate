import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = async () => {
	try {
		getDb().prepare('SELECT 1').get();
		return json({ ok: true, status: 'healthy' });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : 'db error' }, { status: 503 });
	}
};
