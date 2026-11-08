import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startRegistration, finishRegistration } from '$lib/server/auth/webauthn';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const { options, challengeId } = await startRegistration();
	return json({ options, challengeId });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const body = await request.json();
	try {
		await finishRegistration(body.challengeId, body.response, body.name ?? 'Passkey');
		return json({ ok: true });
	} catch (err) {
		return json({ ok: false, error: err instanceof Error ? err.message : 'Registration failed' }, { status: 400 });
	}
};
