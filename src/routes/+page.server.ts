import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSetting } from '$lib/server/db';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session) throw redirect(303, '/login');
	const view = getSetting('default_view') ?? 'today';
	throw redirect(303, `/${['today', 'mail', 'calendar', 'tasks', 'contacts'].includes(view) ? view : 'today'}`);
};
