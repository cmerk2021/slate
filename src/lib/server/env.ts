import { env as dyn } from '$env/dynamic/private';

function int(v: string | undefined, d: number): number {
	const n = parseInt(v ?? '', 10);
	return Number.isFinite(n) ? n : d;
}

export const env = {
	get PORT() { return int(dyn.PORT, 3000); },
	get APP_ORIGIN() { return dyn.APP_ORIGIN || 'http://localhost:3000'; },
	get RP_ID() { return dyn.RP_ID || new URL(dyn.APP_ORIGIN || 'http://localhost:3000').hostname; },
	get APP_SECRET() { return dyn.APP_SECRET || ''; },
	get DATA_DIR() { return dyn.DATA_DIR || (process.env.NODE_ENV === 'development' || process.env.VITEST ? './data' : '/data'); },
	get SESSION_DAYS() { return int(dyn.SESSION_DAYS, 30); },
	get CACHE_MAX_MB() { return int(dyn.CACHE_MAX_MB, 2048); },
	get LOG_LEVEL() { return dyn.LOG_LEVEL || 'info'; },
	get TRUST_PROXY() { return dyn.TRUST_PROXY === '1' || dyn.TRUST_PROXY === 'true'; },
	get MAX_ATTACHMENT_MB() { return int(dyn.MAX_ATTACHMENT_MB, 25); }
};
