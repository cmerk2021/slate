import type { RequestHandler } from './$types';
import { subscribe, type SlateEvent } from '$lib/server/events';
import { error } from '@sveltejs/kit';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);

	let cleanup: (() => void) | null = null;
	const stream = new ReadableStream({
		start(controller) {
			const enc = new TextEncoder();
			const send = (ev: SlateEvent) => {
				// deliver global events and events for any profile (badges), client filters detail
				try {
					controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify({ profileId: ev.profileId ?? null, ...((ev.data as object) ?? {}) })}\n\n`));
				} catch { /* closed */ }
			};
			controller.enqueue(enc.encode(`: connected profile=${profileId}\n\n`));
			const unsub = subscribe(send);
			const ping = setInterval(() => {
				try {
					controller.enqueue(enc.encode(': ping\n\n'));
				} catch { /* closed */ }
			}, 25000);
			cleanup = () => {
				unsub();
				clearInterval(ping);
			};
		},
		cancel() {
			cleanup?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
