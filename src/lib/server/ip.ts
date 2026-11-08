import { env } from './env';

/** Resolve the real client IP, honoring TRUST_PROXY for X-Forwarded-For. */
export function getClientIp(event: { request: Request; getClientAddress(): string }): string {
	if (env.TRUST_PROXY) {
		const xff = event.request.headers.get('x-forwarded-for');
		if (xff) return xff.split(',')[0].trim();
	}
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}
