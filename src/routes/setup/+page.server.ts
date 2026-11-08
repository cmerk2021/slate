import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { isSetupDone, setupPassword, createSession } from '$lib/server/auth';
import { createProfile, listProfiles } from '$lib/server/profiles';
import { env } from '$lib/server/env';
import { getClientIp } from '$lib/server/ip';

export const load: PageServerLoad = async () => {
	if (isSetupDone()) throw redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		if (isSetupDone()) return fail(403, { error: 'Setup is already complete.' });
		const data = await event.request.formData();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');
		const profileName = String(data.get('profileName') ?? 'Personal').trim() || 'Personal';
		const profileIcon = String(data.get('profileIcon') ?? '🏠');

		if (password.length < 12) return fail(400, { error: 'Password must be at least 12 characters.' });
		if (password !== confirm) return fail(400, { error: 'Passwords do not match.' });

		await setupPassword(password);
		if (listProfiles().length === 0) {
			createProfile({ name: profileName, icon: profileIcon });
		}
		const sessionId = createSession(getClientIp(event), event.request.headers.get('user-agent') ?? undefined);
		event.cookies.set('slate_session', sessionId, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: env.APP_ORIGIN.startsWith('https'),
			maxAge: env.SESSION_DAYS * 86400
		});
		throw redirect(303, '/today');
	}
};
