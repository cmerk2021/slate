/** Date/time formatting helpers (client-safe, Intl-based). */

export function fmtTime(ms: number, timeFormat: '12' | '24' = '12'): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: 'numeric',
		minute: '2-digit',
		hour12: timeFormat === '12'
	}).format(new Date(ms));
}

export function fmtDate(ms: number): string {
	return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(ms));
}

export function fmtDateShort(ms: number): string {
	return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ms));
}

export function fmtWeekday(ms: number): string {
	return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(ms));
}

/** Gmail-ish list timestamp: time if today, "Mon" if this week, else "Jan 5". */
export function fmtListDate(ms: number, timeFormat: '12' | '24' = '12'): string {
	const d = new Date(ms);
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ms >= startOfToday) return fmtTime(ms, timeFormat);
	if (ms >= startOfToday - 6 * 86400_000) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
	if (d.getFullYear() === now.getFullYear()) return fmtDateShort(ms);
	return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: '2-digit' }).format(d);
}

export function fmtRelative(ms: number): string {
	const diff = ms - Date.now();
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
	if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
	return rtf.format(Math.round(diff / 86400_000), 'day');
}

export function fmtDuration(startMs: number, endMs: number, timeFormat: '12' | '24' = '12'): string {
	return `${fmtTime(startMs, timeFormat)} – ${fmtTime(endMs, timeFormat)}`;
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function isToday(ms: number): boolean {
	const d = new Date(ms), n = new Date();
	return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export function startOfDay(d = new Date()): number {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return '?';
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic hue for an email/name avatar. */
export function avatarHue(key: string): number {
	let h = 0;
	for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
	return h % 360;
}
