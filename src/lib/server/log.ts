import { env } from './env';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SECRET_KEYS = /pass(word)?|secret|token|credential|authorization/i;

function redact(obj: unknown): unknown {
	if (obj === null || typeof obj !== 'object') return obj;
	if (Array.isArray(obj)) return obj.map(redact);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v);
	}
	return out;
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>) {
	const min = LEVELS[(env.LOG_LEVEL as Level) in LEVELS ? (env.LOG_LEVEL as Level) : 'info'];
	if (LEVELS[level] < min) return;
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg,
		...(ctx ? (redact(ctx) as Record<string, unknown>) : {})
	});
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}

export const log = {
	debug: (msg: string, ctx?: Record<string, unknown>) => emit('debug', msg, ctx),
	info: (msg: string, ctx?: Record<string, unknown>) => emit('info', msg, ctx),
	warn: (msg: string, ctx?: Record<string, unknown>) => emit('warn', msg, ctx),
	error: (msg: string, ctx?: Record<string, unknown>) => emit('error', msg, ctx)
};
