import type { Handle, ServerInit } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { building } from '$app/environment';
import { validateSession } from '$lib/server/auth';
import { isSetupDone } from '$lib/server/auth';
import { env } from '$lib/server/env';
import { log } from '$lib/server/log';

export const init: ServerInit = async () => {
	if (building) return;
	const { getDb, closeDb } = await import('$lib/server/db');
	getDb();
	const { startBackground, stopBackground } = await import('$lib/server/background');
	startBackground();
	const shutdown = async (sig: string) => {
		log.info('shutting down', { signal: sig });
		try {
			await stopBackground();
		} finally {
			closeDb();
			process.exit(0);
		}
	};
	process.once('SIGINT', () => void shutdown('SIGINT'));
	process.once('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('unhandledRejection', (err) => log.error('unhandledRejection', { error: String(err) }));
};

const PUBLIC_PATHS = new Set(['/login', '/setup', '/healthz', '/manifest.webmanifest', '/offline']);

function isPublic(path: string): boolean {
	if (PUBLIC_PATHS.has(path)) return true;
	if (path.startsWith('/api/auth/')) return true;
	if (path.startsWith('/fonts/') || path.startsWith('/icons/') || path === '/favicon.svg' || path === '/sw.js') return true;
	return false;
}

export const handle: Handle = async ({ event, resolve }) => {
	const sid = event.cookies.get('slate_session');
	event.locals.session = validateSession(sid);
	event.locals.setupDone = isSetupDone();

	const path = event.url.pathname;

	if (!building) {
		if (!event.locals.setupDone && !isPublic(path) && path !== '/setup') {
			redirect(303, '/setup');
		}
		if (event.locals.setupDone && path === '/setup') {
			redirect(303, event.locals.session ? '/' : '/login');
		}
		if (!event.locals.session && !isPublic(path)) {
			redirect(303, '/login');
		}
		if (event.locals.session && path === '/login') {
			redirect(303, '/');
		}
	}

	const response = await resolve(event);

	// security headers
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	if (!path.startsWith('/api/')) {
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'"
		);
	}
	return response;
};
