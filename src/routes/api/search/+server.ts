import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { search } from '$lib/server/mail/search';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);
	const q = url.searchParams.get('q') ?? '';
	const server = url.searchParams.get('server') === '1';
	if (!q.trim()) return json({ local: [], server: [] });
	const results = await search(profileId, q, server);
	return json(results);
};
