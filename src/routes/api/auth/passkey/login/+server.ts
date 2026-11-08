import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startAuthentication, finishAuthentication } from '$lib/server/auth/webauthn';
import { createSession, checkRateLimit, recordFailure, recordSuccess } from '$lib/server/auth';
import { env } from '$lib/server/env';
import { getClientIp } from '$lib/server/ip';

export const GET: RequestHandler = async () => {
	const { options, challengeId } = await startAuthentication();
	return json({ options, challengeId });
};

export const POST: RequestHandler = async (event) => {
	const ip = getClientIp(event);
	const ipLimit = checkRateLimit('login:' + ip);
	const globalLimit = checkRateLimit('login:global');
	if (!ipLimit.allowed || !globalLimit.allowed) {
		const retry = Math.max(ipLimit.retryAfterMs, globalLimit.retryAfterMs);
		return json({ ok: false, error: `Too many attempts. Try again in ${Math.ceil(retry / 1000)}s.` }, { status: 429 });
	}
	const body = await event.request.json();
	try {
		const ok = await finishAuthentication(body.challengeId, body.response);
		if (!ok) {
			recordFailure('login:' + ip);
			recordFailure('login:global');
			return json({ ok: false, error: 'Passkey verification failed' }, { status: 401 });
		}
		recordSuccess('login:' + ip);
		const sid = createSession(ip, event.request.headers.get('user-agent') ?? undefined);
		event.cookies.set('slate_session', sid, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: env.APP_ORIGIN.startsWith('https'),
			maxAge: env.SESSION_DAYS * 86400
		});
		return json({ ok: true });
	} catch (err) {
		recordFailure('login:' + ip);
		return json({ ok: false, error: err instanceof Error ? err.message : 'Login failed' }, { status: 401 });
	}
};
