import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createProfile, deleteProfile, listProfiles, updateProfile, profileUnreadCounts } from '$lib/server/profiles';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	return json({ profiles: listProfiles(), unread: profileUnreadCounts() });
};

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const body = await request.json();
	switch (body.action) {
		case 'create': {
			const id = createProfile({ name: body.name, icon: body.icon, accentH: body.accentH, theme: body.theme });
			return json({ ok: true, profileId: id });
		}
		case 'update': {
			updateProfile(body.profileId, body.updates);
			return json({ ok: true });
		}
		case 'delete': {
			if (listProfiles().length <= 1) return json({ ok: false, error: 'Cannot delete the last profile' }, { status: 400 });
			deleteProfile(body.profileId);
			return json({ ok: true });
		}
		case 'reorder': {
			(body.order as number[]).forEach((id, i) => updateProfile(id, { sort_order: i }));
			return json({ ok: true });
		}
		case 'switch': {
			cookies.set('slate_profile', String(body.profileId), { path: '/', httpOnly: false, sameSite: 'lax', maxAge: 365 * 86400 });
			return json({ ok: true });
		}
		default:
			throw error(400, 'Unknown action');
	}
};
