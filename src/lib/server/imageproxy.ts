import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** SSRF-protected image proxy helpers. */

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

function isPrivateIp(ip: string): boolean {
	if (ip.includes(':')) {
		const low = ip.toLowerCase();
		return (
			low === '::1' || low === '::' ||
			low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd') ||
			low.startsWith('::ffff:') && isPrivateIp(low.slice(7))
		);
	}
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some((p) => isNaN(p))) return true;
	const [a, b] = parts;
	return (
		a === 0 || a === 10 || a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

export async function validateImageUrl(raw: string): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, error: 'Invalid URL' };
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Only http(s) URLs allowed' };
	if (url.username || url.password) return { ok: false, error: 'Credentials in URL not allowed' };
	const host = url.hostname;
	if (isIP(host)) {
		if (isPrivateIp(host)) return { ok: false, error: 'Private address blocked' };
	} else {
		try {
			const res = await lookup(host, { all: true });
			if (res.some((r) => isPrivateIp(r.address))) return { ok: false, error: 'Private address blocked' };
		} catch {
			return { ok: false, error: 'Host not resolvable' };
		}
	}
	return { ok: true, url };
}

export async function fetchImage(url: URL): Promise<{ body: ReadableStream<Uint8Array> | null; contentType: string; status: number } | { error: string; status: number }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			redirect: 'error', // avoid redirect-based SSRF
			headers: { Accept: 'image/*', 'User-Agent': 'Slate-ImageProxy/1.0' }
		});
		if (!res.ok) return { error: `Upstream returned ${res.status}`, status: 502 };
		const ct = res.headers.get('content-type') ?? '';
		if (!ct.startsWith('image/')) return { error: 'Not an image', status: 415 };
		const len = parseInt(res.headers.get('content-length') ?? '0', 10);
		if (len > MAX_BYTES) return { error: 'Image too large', status: 413 };
		return { body: res.body, contentType: ct, status: 200 };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { error: /abort/i.test(msg) ? 'Timed out' : 'Fetch failed', status: 504 };
	} finally {
		clearTimeout(timer);
	}
}

export { MAX_BYTES as IMAGE_PROXY_MAX_BYTES };
