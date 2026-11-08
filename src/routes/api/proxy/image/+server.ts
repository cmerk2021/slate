import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { validateImageUrl, fetchImage } from '$lib/server/imageproxy';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const raw = url.searchParams.get('url');
	if (!raw) throw error(400, 'Missing url');
	const valid = await validateImageUrl(raw);
	if (!valid.ok) throw error(403, valid.error);
	const result = await fetchImage(valid.url);
	if ('error' in result) throw error(result.status, result.error);
	return new Response(result.body, {
		headers: {
			'Content-Type': result.contentType,
			'Cache-Control': 'private, max-age=86400',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'"
		}
	});
};
