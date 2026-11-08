/** Natural-language date parsing for quick-add ("lunch with Sam tomorrow 1pm", "pay rent friday !high"). Unit tested. */

export interface ParsedQuickAdd {
	title: string;
	start: Date | null;
	end: Date | null;
	allDay: boolean;
	priority: number | null; // VTODO priority: 1 high, 5 medium, 9 low
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function parseQuickAdd(input: string, now = new Date()): ParsedQuickAdd {
	let text = input.trim();
	let priority: number | null = null;
	let date: Date | null = null;
	let time: { h: number; m: number } | null = null;
	let endTime: { h: number; m: number } | null = null;

	// priority markers
	text = text.replace(/\s*!(high|medium|med|low|[1-9])\b/i, (_m, p: string) => {
		const pl = p.toLowerCase();
		priority = pl === 'high' ? 1 : pl === 'low' ? 9 : /^\d$/.test(pl) ? parseInt(pl, 10) : 5;
		return '';
	});

	// time range "1pm-2:30pm" or "13:00-14:00"
	const rangeRe = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
	const rangeM = text.match(rangeRe);
	if (rangeM && (rangeM[3] || rangeM[6] || rangeM[2] || rangeM[5])) {
		time = toTime(rangeM[1], rangeM[2], rangeM[3] ?? rangeM[6]);
		endTime = toTime(rangeM[4], rangeM[5], rangeM[6] ?? rangeM[3]);
		text = text.replace(rangeRe, '');
	} else {
		// single time "at 1pm" / "1:30pm" / "13:00"
		const timeRe = /\b(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\b|\b(?:at\s+)?(\d{1,2})\s*(am|pm)\b/i;
		const tm = text.match(timeRe);
		if (tm) {
			time = tm[1] !== undefined ? toTime(tm[1], tm[2], tm[3]) : toTime(tm[4], undefined, tm[5]);
			text = text.replace(timeRe, '');
		}
	}

	// dates
	const lower = () => text.toLowerCase();
	if (/\btoday\b/i.test(text)) {
		date = startOfDay(now);
		text = text.replace(/\btoday\b/i, '');
	} else if (/\btomorrow\b/i.test(text)) {
		date = addDays(startOfDay(now), 1);
		text = text.replace(/\btomorrow\b/i, '');
	} else if (/\bnext week\b/i.test(text)) {
		date = addDays(startOfDay(now), ((8 - now.getDay()) % 7) || 7);
		text = text.replace(/\bnext week\b/i, '');
	} else {
		// weekday names ("friday", "next friday")
		for (let i = 0; i < 7; i++) {
			const re = new RegExp(`\\b(next\\s+)?(${WEEKDAYS[i]}|${WEEKDAYS[i].slice(0, 3)})\\b`, 'i');
			const m = lower().match(re);
			if (m) {
				let delta = (i - now.getDay() + 7) % 7;
				if (delta === 0) delta = 7;
				if (m[1]) delta += delta <= 7 && delta !== 7 ? 7 : 0;
				date = addDays(startOfDay(now), delta);
				text = text.replace(re, '');
				break;
			}
		}
		// "jan 5", "january 5", "5 jan"
		if (!date) {
			for (let i = 0; i < 12; i++) {
				const mon = MONTHS[i];
				const re = new RegExp(`\\b(?:(${mon}|${mon.slice(0, 3)})\\.?\\s+(\\d{1,2})|(\\d{1,2})\\s+(${mon}|${mon.slice(0, 3)})\\.?)\\b`, 'i');
				const m = lower().match(re);
				if (m) {
					const day = parseInt(m[2] ?? m[3], 10);
					const d = new Date(now.getFullYear(), i, day);
					if (d.getTime() < startOfDay(now).getTime()) d.setFullYear(d.getFullYear() + 1);
					date = d;
					text = text.replace(re, '');
					break;
				}
			}
		}
		// ISO dates
		if (!date) {
			const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
			if (iso) {
				date = new Date(+iso[1], +iso[2] - 1, +iso[3]);
				text = text.replace(iso[0], '');
			}
		}
	}

	const title = text.replace(/\s+/g, ' ').replace(/\s+(at|on)\s*$/i, '').trim();

	if (!date && !time) return { title, start: null, end: null, allDay: false, priority };

	const base = date ?? startOfDay(now);
	let start: Date;
	let end: Date;
	let allDay = false;
	if (time) {
		start = new Date(base);
		start.setHours(time.h, time.m, 0, 0);
		if (!date && start.getTime() < now.getTime()) start = addDays(start, 1);
		end = endTime ? new Date(base) : new Date(start.getTime() + 3600_000);
		if (endTime) {
			end.setHours(endTime.h, endTime.m, 0, 0);
			if (end <= start) end = new Date(start.getTime() + 3600_000);
		}
	} else {
		allDay = true;
		start = base;
		end = addDays(base, 1);
	}
	return { title, start, end, allDay, priority };
}

function toTime(hStr: string, mStr: string | undefined, ampm: string | undefined): { h: number; m: number } {
	let h = parseInt(hStr, 10);
	const m = mStr ? parseInt(mStr, 10) : 0;
	if (ampm?.toLowerCase() === 'pm' && h < 12) h += 12;
	if (ampm?.toLowerCase() === 'am' && h === 12) h = 0;
	return { h, m };
}

function startOfDay(d: Date): Date {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

function addDays(d: Date, days: number): Date {
	const x = new Date(d);
	x.setDate(x.getDate() + days);
	return x;
}
