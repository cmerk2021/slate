import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { isSetupDone, verifyPassword, createSession, checkRateLimit, recordFailure, recordSuccess } from '$lib/server/auth';
import { hasPasskeys } from '$lib/server/auth/webauthn';
import { env } from '$lib/server/env';
import { getClientIp } from '$lib/server/ip';
import { log } from '$lib/server/log';

export const load: PageServerLoad = async ({ locals }) => {
	if (!isSetupDone()) throw redirect(303, '/setup');
	if (locals.session) throw redirect(303, '/today');
	const secureOrigin = env.APP_ORIGIN.startsWith('https') || env.RP_ID === 'localhost';
	return { hasPasskeys: hasPasskeys(), passkeysAvailable: secureOrigin };
};

export const actions: Actions = {
	default: async (event) => {
		const ip = getClientIp(event);
		const rl = checkRateLimit(`login:${ip}`);
		const rlGlobal = checkRateLimit('login:global');
		if (!rl.allowed || !rlGlobal.allowed) {
			const wait = Math.ceil(Math.max(rl.retryAfterMs, rlGlobal.retryAfterMs) / 1000);
			return fail(429, { error: `Too many attempts. Try again in ${wait}s.` });
		}
		const data = await event.request.formData();
		const password = String(data.get('password') ?? '');
		if (!(await verifyPassword(password))) {
			recordFailure(`login:${ip}`);
			recordFailure('login:global');
			log.warn('failed login', { ip });
			return fail(400, { error: 'Incorrect password.' });
		}
		recordSuccess(`login:${ip}`);
		const sessionId = createSession(ip, event.request.headers.get('user-agent') ?? undefined);
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
