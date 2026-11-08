// Slate service worker: app-shell caching with offline fallback.
// Never caches mail content or API responses.
const VERSION = 'slate-v1';
const SHELL = ['/offline', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'GET') return;
	// never intercept API, SSE, or auth routes
	if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/logout') return;

	// static immutable assets: cache-first
	if (url.pathname.startsWith('/_app/immutable/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
		event.respondWith(
			caches.open(VERSION).then(async (cache) => {
				const hit = await cache.match(event.request);
				if (hit) return hit;
				const res = await fetch(event.request);
				if (res.ok) cache.put(event.request, res.clone());
				return res;
			})
		);
		return;
	}

	// navigations: network-first with offline fallback
	if (event.request.mode === 'navigate') {
		event.respondWith(
			fetch(event.request).catch(() => caches.match('/offline').then((r) => r ?? Response.error()))
		);
	}
});
