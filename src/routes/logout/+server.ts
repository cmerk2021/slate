import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { revokeSession } from '$lib/server/auth';

export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (locals.session) revokeSession(locals.session.id);
	cookies.delete('slate_session', { path: '/' });
	throw redirect(303, '/login');
};
