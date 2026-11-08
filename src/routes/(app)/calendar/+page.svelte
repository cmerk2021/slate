<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { sse } from '$lib/client/sse.svelte';
	import { shortcuts } from '$lib/client/shortcuts.svelte';
	import { fmtTime } from '$lib/client/format';
	import EventEditor, { type CalInfo, type EditorEvent } from '$lib/components/calendar/EventEditor.svelte';

	let { data } = $props();

	interface Cal extends CalInfo { visible: number; account_name: string; supports_vevent: number }
	interface Ev {
		objectId: number; calendarId: number; uid: string; recurrenceId: string | null;
		summary: string; description: string; location: string;
		start: number; end: number; allDay: boolean; isRecurring: boolean;
		color: string | null; calName: string;
		alarms?: number[];
		attendees?: { email: string; name: string; partstat: string }[];
	}

	type View = 'month' | 'week' | 'day' | 'agenda';
	let view = $state<View>('week');
	let cursor = $state(new Date());
	let calendars = $state<Cal[]>([]);
	let events = $state<Ev[]>([]);
	let loading = $state(false);
	let editing = $state<EditorEvent | null>(null);
	let quickCreate = $state<{ x: number; y: number; start: number; end: number; allDay: boolean } | null>(null);
	let quickText = $state('');
	let nowTick = $state(Date.now());

	const weekStart = data.settings.weekStart; // 0=Sun 1=Mon
	const HOUR_PX = 48;

	$effect(() => {
		const t = setInterval(() => (nowTick = Date.now()), 60_000);
		return () => clearInterval(t);
	});

	// ---------- date math ----------
	function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
	function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
	function startOfWeek(d: Date): Date {
		const x = startOfDay(d);
		const diff = (x.getDay() - weekStart + 7) % 7;
		return addDays(x, -diff);
	}
	function sameDay(a: Date | number, b: Date | number): boolean {
		const x = new Date(a), y = new Date(b);
		return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
	}

	const range = $derived.by(() => {
		if (view === 'day') return { start: startOfDay(cursor), end: addDays(startOfDay(cursor), 1) };
		if (view === 'week') { const s = startOfWeek(cursor); return { start: s, end: addDays(s, 7) }; }
		if (view === 'agenda') return { start: startOfDay(cursor), end: addDays(startOfDay(cursor), 30) };
		const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
		const gridStart = startOfWeek(first);
		return { start: gridStart, end: addDays(gridStart, 42) };
	});

	const weekDays = $derived.by(() => {
		const days: Date[] = [];
		const n = view === 'day' ? 1 : 7;
		const s = view === 'day' ? startOfDay(cursor) : startOfWeek(cursor);
		for (let i = 0; i < n; i++) days.push(addDays(s, i));
		return days;
	});

	const monthWeeks = $derived.by(() => {
		const weeks: Date[][] = [];
		let d = range.start;
		for (let w = 0; w < 6; w++) {
			const row: Date[] = [];
			for (let i = 0; i < 7; i++) { row.push(d); d = addDays(d, 1); }
			weeks.push(row);
		}
		return weeks;
	});

	const title = $derived.by(() => {
		if (view === 'day') return cursor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
		if (view === 'week') {
			const s = startOfWeek(cursor), e = addDays(s, 6);
			return s.getMonth() === e.getMonth()
				? s.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
				: `${s.toLocaleDateString(undefined, { month: 'short' })} – ${e.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
		}
		return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
	});

	function navigate(dir: number) {
		if (view === 'day') cursor = addDays(cursor, dir);
		else if (view === 'week') cursor = addDays(cursor, dir * 7);
		else if (view === 'agenda') cursor = addDays(cursor, dir * 30);
		else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1);
	}

	// ---------- loading ----------
	async function loadCalendars() {
		try {
			const res = await apiGet<{ calendars: Cal[] }>(`/api/calendar?profile=${data.profile.id}&view=calendars`);
			calendars = res.calendars;
		} catch { calendars = []; }
	}

	async function loadEvents() {
		loading = true;
		try {
			const res = await apiGet<{ events: Ev[] }>(`/api/calendar?profile=${data.profile.id}&view=events&start=${range.start.getTime()}&end=${range.end.getTime()}`);
			events = res.events;
			scheduleReminders(res.events);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not load events');
		} finally {
			loading = false;
		}
	}

	let lastRangeKey = '';
	$effect(() => {
		const key = `${data.profile.id}|${range.start.getTime()}|${range.end.getTime()}`;
		if (key !== lastRangeKey) { lastRangeKey = key; void loadEvents(); }
	});
	$effect(() => { void data.profile.id; void loadCalendars(); });
	$effect(() => {
		const off = sse.on('calendar', () => { void loadEvents(); void loadCalendars(); });
		return off;
	});

	// ---------- reminders (VALARM → browser notifications, opt-in) ----------
	let reminderTimers: ReturnType<typeof setTimeout>[] = [];
	function scheduleReminders(evs: Ev[]) {
		for (const t of reminderTimers) clearTimeout(t);
		reminderTimers = [];
		const optIn = (data.profileSettings['notifications'] as boolean) ?? false;
		const now = Date.now();
		for (const ev of evs) {
			for (const mins of ev.alarms ?? []) {
				const at = ev.start - mins * 60_000;
				if (at > now && at - now < 12 * 3600_000) {
					reminderTimers.push(setTimeout(() => {
						toasts.show(`⏰ ${ev.summary} ${mins === 0 ? 'starts now' : `in ${mins} min`}`, 'info', 10000);
						if (optIn && 'Notification' in window && Notification.permission === 'granted') {
							new Notification(ev.summary, { body: `Starts ${new Date(ev.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}${ev.location ? ` · ${ev.location}` : ''}`, icon: '/icons/icon-192.png' });
						}
					}, at - now));
				}
			}
		}
	}
	$effect(() => () => { for (const t of reminderTimers) clearTimeout(t); });

	// ---------- event helpers ----------
	function eventsOn(day: Date): Ev[] {
		const s = startOfDay(day).getTime(), e = s + 86400000;
		return events.filter((ev) => ev.start < e && ev.end > s);
	}
	function timedOn(day: Date): Ev[] { return eventsOn(day).filter((e) => !e.allDay); }
	function allDayOn(day: Date): Ev[] { return eventsOn(day).filter((e) => e.allDay); }

	/** column layout for overlapping events */
	function layoutDay(evs: Ev[]): (Ev & { col: number; cols: number })[] {
		const sorted = [...evs].sort((a, b) => a.start - b.start || b.end - a.end);
		const placed: (Ev & { col: number; cols: number })[] = [];
		const clusters: (Ev & { col: number; cols: number })[][] = [];
		for (const ev of sorted) {
			let cluster = clusters.find((c) => c.some((p) => p.start < ev.end && p.end > ev.start));
			if (!cluster) { cluster = []; clusters.push(cluster); }
			const used = new Set(cluster.filter((p) => p.start < ev.end && p.end > ev.start).map((p) => p.col));
			let col = 0;
			while (used.has(col)) col++;
			const pl = { ...ev, col, cols: 1 };
			cluster.push(pl);
			placed.push(pl);
		}
		for (const cluster of clusters) {
			const cols = Math.max(...cluster.map((p) => p.col)) + 1;
			for (const p of cluster) p.cols = cols;
		}
		return placed;
	}

	function evTop(ev: Ev, day: Date): number {
		const dayStart = startOfDay(day).getTime();
		return Math.max(0, (ev.start - dayStart) / 3600000) * HOUR_PX;
	}
	function evHeight(ev: Ev, day: Date): number {
		const dayStart = startOfDay(day).getTime();
		const s = Math.max(ev.start, dayStart);
		const e = Math.min(ev.end, dayStart + 86400000);
		return Math.max(20, ((e - s) / 3600000) * HOUR_PX - 2);
	}

	const defaultCalId = $derived(calendars.find((c) => c.is_default)?.id ?? calendars[0]?.id ?? 0);
	const organizerEmail = $derived(data.accounts.find((a) => a.kind === 'imap' || a.kind === 'pop3')?.email ?? null);

	function openEditor(ev: Ev) {
		editing = {
			objectId: ev.objectId, calendarId: ev.calendarId,
			summary: ev.summary, description: ev.description ?? '', location: ev.location ?? '',
			start: ev.start, end: ev.end, allDay: ev.allDay,
			isRecurring: ev.isRecurring, recurrenceStart: ev.start,
			rrule: undefined, attendees: ev.attendees
		};
	}

	function newEventAt(start: number, end: number, allDay = false) {
		if (calendars.length === 0) { toasts.error('Connect a CalDAV account first.'); return; }
		editing = {
			calendarId: defaultCalId,
			summary: '', description: '', location: '',
			start, end, allDay, isRecurring: false
		};
	}

	// ---------- drag create / move / resize ----------
	let drag: { kind: 'create' | 'move' | 'resize'; day: Date; startY: number; origStart: number; origEnd: number; ev?: Ev } | null = null;
	let dragPreview = $state<{ day: Date; start: number; end: number } | null>(null);
	let dragMoved = false;

	function snap(ms: number): number { return Math.round(ms / (15 * 60000)) * 15 * 60000; }

	function gridPointerDown(e: PointerEvent, day: Date) {
		if ((e.target as HTMLElement).closest('.event-block')) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const y = e.clientY - rect.top;
		const start = snap(startOfDay(day).getTime() + (y / HOUR_PX) * 3600000);
		drag = { kind: 'create', day, startY: y, origStart: start, origEnd: start + 30 * 60000 };
		dragMoved = false;
		dragPreview = { day, start, end: start + 30 * 60000 };
		window.addEventListener('pointermove', gridPointerMove);
		window.addEventListener('pointerup', gridPointerUp);
	}

	function evPointerDown(e: PointerEvent, ev: Ev, day: Date, resize = false) {
		e.stopPropagation();
		const col = (e.currentTarget as HTMLElement).closest('.day-col') as HTMLElement;
		const rect = col.getBoundingClientRect();
		drag = { kind: resize ? 'resize' : 'move', day, startY: e.clientY - rect.top, origStart: ev.start, origEnd: ev.end, ev };
		dragMoved = false;
		window.addEventListener('pointermove', gridPointerMove);
		window.addEventListener('pointerup', gridPointerUp);
	}

	function gridPointerMove(e: PointerEvent) {
		if (!drag) return;
		const cols = document.querySelectorAll<HTMLElement>('.day-col');
		let targetDay = drag.day;
		let targetCol: HTMLElement | null = null;
		for (const c of Array.from(cols)) {
			const r = c.getBoundingClientRect();
			if (e.clientX >= r.left && e.clientX <= r.right) { targetCol = c; targetDay = new Date(parseInt(c.dataset.day!, 10)); break; }
		}
		if (!targetCol) targetCol = document.querySelector<HTMLElement>(`.day-col[data-day="${startOfDay(drag.day).getTime()}"]`);
		if (!targetCol) return;
		const rect = targetCol.getBoundingClientRect();
		const y = e.clientY - rect.top;
		if (Math.abs(y - drag.startY) > 4 || !sameDay(targetDay, drag.day)) dragMoved = true;
		if (!dragMoved) return;

		if (drag.kind === 'create') {
			const cur = snap(startOfDay(targetDay).getTime() + (y / HOUR_PX) * 3600000);
			const s = Math.min(drag.origStart, cur);
			const en = Math.max(drag.origStart + 15 * 60000, Math.max(drag.origStart, cur) + (cur >= drag.origStart ? 15 * 60000 : 0));
			dragPreview = { day: targetDay, start: s, end: Math.max(en, s + 15 * 60000) };
		} else if (drag.kind === 'move' && drag.ev) {
			const deltaMs = snap(((y - drag.startY) / HOUR_PX) * 3600000);
			const dayDelta = startOfDay(targetDay).getTime() - startOfDay(drag.day).getTime();
			dragPreview = { day: targetDay, start: drag.origStart + deltaMs + dayDelta, end: drag.origEnd + deltaMs + dayDelta };
		} else if (drag.kind === 'resize' && drag.ev) {
			const end = snap(startOfDay(drag.day).getTime() + (y / HOUR_PX) * 3600000);
			dragPreview = { day: drag.day, start: drag.origStart, end: Math.max(end, drag.origStart + 15 * 60000) };
		}
	}

	async function gridPointerUp(e: PointerEvent) {
		window.removeEventListener('pointermove', gridPointerMove);
		window.removeEventListener('pointerup', gridPointerUp);
		const d = drag; const preview = dragPreview;
		drag = null; dragPreview = null;
		if (!d) return;

		if (d.kind === 'create') {
			if (!preview) return;
			if (!dragMoved) {
				// simple click → quick-create popover
				quickCreate = { x: Math.min(e.clientX, window.innerWidth - 340), y: Math.min(e.clientY, window.innerHeight - 160), start: preview.start, end: preview.start + 3600000, allDay: false };
				quickText = '';
				return;
			}
			newEventAt(preview.start, preview.end);
			return;
		}

		if (!dragMoved || !preview || !d.ev) {
			if (d.ev && !dragMoved) openEditor(d.ev);
			return;
		}

		// move / resize → persist
		const ev = d.ev;
		const prev = events;
		events = events.map((x) => x === ev || (x.objectId === ev.objectId && x.start === ev.start) ? { ...x, start: preview.start, end: preview.end } : x);
		try {
			await apiPost('/api/calendar', {
				action: 'update',
				calendarId: ev.calendarId, objectId: ev.objectId,
				scope: ev.isRecurring ? 'one' : undefined,
				occurrenceStart: ev.isRecurring ? ev.start : undefined,
				start: preview.start, end: preview.end
			});
			void loadEvents();
		} catch (err) {
			events = prev;
			toasts.error(err instanceof Error ? err.message : 'Could not move the event');
		}
	}

	// ---------- quick create ----------
	async function submitQuickCreate() {
		if (!quickCreate) return;
		if (calendars.length === 0) { toasts.error('Connect a CalDAV account first.'); return; }
		const qc = quickCreate;
		try {
			if (quickText.trim()) {
				const res = await apiPost<{ ok: boolean; error?: string }>('/api/calendar', { action: 'quick-create', calendarId: defaultCalId, text: quickText.trim() });
				if (!res.ok) { toasts.error(res.error ?? 'Could not parse that'); return; }
				toasts.success('Event created');
				quickCreate = null;
				void loadEvents();
			} else {
				quickCreate = null;
				newEventAt(qc.start, qc.end);
			}
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not create');
		}
	}

	// ---------- calendar toggles ----------
	async function toggleCal(c: Cal) {
		c.visible = c.visible ? 0 : 1;
		calendars = [...calendars];
		await apiPost('/api/calendar', { action: 'toggle-visible', calendarId: c.id, visible: !!c.visible });
		void loadEvents();
	}

	async function syncNow() {
		toasts.show('Syncing calendars…');
		try {
			await apiPost('/api/calendar', { action: 'sync', profileId: data.profile.id });
			await loadCalendars();
			await loadEvents();
			toasts.success('Calendars synced');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Sync failed');
		}
	}

	// ---------- mini calendar ----------
	const miniWeeks = $derived.by(() => {
		const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
		const gs = startOfWeek(first);
		const weeks: Date[][] = [];
		let d = gs;
		for (let w = 0; w < 6; w++) {
			const row: Date[] = [];
			for (let i = 0; i < 7; i++) { row.push(d); d = addDays(d, 1); }
			weeks.push(row);
		}
		return weeks;
	});

	// ---------- agenda ----------
	const agendaDays = $derived.by(() => {
		const out: { day: Date; evs: Ev[] }[] = [];
		for (let i = 0; i < 30; i++) {
			const day = addDays(startOfDay(cursor), i);
			const evs = eventsOn(day);
			if (evs.length) out.push({ day, evs: evs.sort((a, b) => a.start - b.start) });
		}
		return out;
	});

	// shortcuts
	$effect(() => {
		if (!data.settings.shortcutsEnabled) return;
		const offs = [
			shortcuts.register('m', () => { view = 'month'; }),
			shortcuts.register('w', () => { view = 'week'; }),
			shortcuts.register('d', () => { view = 'day'; }),
			shortcuts.register('n', () => newEventAt(Date.now() + 3600000, Date.now() + 7200000)),
			shortcuts.register('arrowleft', () => navigate(-1)),
			shortcuts.register('arrowright', () => navigate(1))
		];
		return () => offs.forEach((f) => f());
	});

	const nowOffset = $derived(((nowTick - startOfDay(new Date(nowTick)).getTime()) / 3600000) * HOUR_PX);
	const videoRe = /https?:\/\/[^\s"<>]*(zoom\.us|meet\.google|teams\.microsoft|webex\.com|whereby\.com|jitsi)[^\s"<>]*/i;
	function calColor(ev: Ev): string { return ev.color || 'hsl(var(--accent-h, 18) 60% 55%)'; }
	const hours = Array.from({ length: 24 }, (_, i) => i);
</script>

<svelte:head><title>Calendar — Slate</title></svelte:head>

<div class="cal-page">
	<!-- sidebar: mini calendar + calendar list -->
	<aside class="cal-side" aria-label="Calendars">
		<button class="btn btn-primary new-btn" onclick={() => newEventAt(Date.now() + 3600000, Date.now() + 7200000)}>+ New event</button>

		<div class="mini">
			<div class="mini-head">
				<button class="mini-nav" onclick={() => (cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
				<span class="mini-title">{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
				<button class="mini-nav" onclick={() => (cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label="Next month">›</button>
			</div>
			<div class="mini-grid" role="grid">
				{#each Array(7) as _, i (i)}
					<span class="mini-dow">{addDays(startOfWeek(new Date()), i).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
				{/each}
				{#each miniWeeks as week, wi (wi)}
					{#each week as day (day.getTime())}
						<button
							class="mini-day tnum"
							class:dim={day.getMonth() !== cursor.getMonth()}
							class:today={sameDay(day, nowTick)}
							class:sel={sameDay(day, cursor)}
							onclick={() => { cursor = day; if (view === 'month') view = 'day'; }}
						>{day.getDate()}</button>
					{/each}
				{/each}
			</div>
		</div>

		<div class="cal-list">
			<div class="cal-list-head">
				<h3>Calendars</h3>
				<button class="mini-nav" title="Sync now" onclick={() => void syncNow()}>↻</button>
			</div>
			{#if calendars.length === 0}
				<p class="cal-empty">No calendars yet. <a href="/settings/accounts">Add a CalDAV account</a>.</p>
			{/if}
			{#each calendars as c (c.id)}
				<label class="cal-item">
					<input type="checkbox" checked={!!c.visible} onchange={() => void toggleCal(c)} />
					<span class="cal-dot" style="background: {c.color || 'var(--accent)'}"></span>
					<span class="cal-name trunc">{c.name}</span>
					{#if c.is_default}<span class="cal-def">default</span>{/if}
				</label>
			{/each}
		</div>
	</aside>

	<!-- main -->
	<section class="cal-main" aria-label="Calendar">
		<header class="cal-head">
			<button class="btn btn-ghost" onclick={() => (cursor = new Date())}>Today</button>
			<button class="nav-arrow" onclick={() => navigate(-1)} aria-label="Previous">‹</button>
			<button class="nav-arrow" onclick={() => navigate(1)} aria-label="Next">›</button>
			<h1 class="cal-title">{title}</h1>
			<span class="grow"></span>
			{#if loading}<span class="spin" aria-label="Loading"></span>{/if}
			<div class="view-tabs" role="tablist" aria-label="Calendar view">
				{#each ['month', 'week', 'day', 'agenda'] as v (v)}
					<button role="tab" aria-selected={view === v} class:on={view === v} onclick={() => (view = v as View)}>{v[0].toUpperCase() + v.slice(1)}</button>
				{/each}
			</div>
		</header>

		{#if view === 'month'}
			<div class="month-grid">
				<div class="month-dows">
					{#each Array(7) as _, i (i)}
						<span>{addDays(startOfWeek(new Date()), i).toLocaleDateString(undefined, { weekday: 'short' })}</span>
					{/each}
				</div>
				{#each monthWeeks as week, wi (wi)}
					<div class="month-week">
						{#each week as day (day.getTime())}
							{@const evs = eventsOn(day)}
							<div
								class="month-cell"
								class:dim={day.getMonth() !== cursor.getMonth()}
								class:today={sameDay(day, nowTick)}
								role="button" tabindex="0"
								onclick={(e) => {
									if ((e.target as HTMLElement).closest('.month-ev')) return;
									quickCreate = { x: Math.min(e.clientX, window.innerWidth - 340), y: Math.min(e.clientY, window.innerHeight - 160), start: startOfDay(day).getTime() + 9 * 3600000, end: startOfDay(day).getTime() + 10 * 3600000, allDay: false };
									quickText = '';
								}}
								onkeydown={(e) => { if (e.key === 'Enter') newEventAt(startOfDay(day).getTime() + 9 * 3600000, startOfDay(day).getTime() + 10 * 3600000); }}
							>
								<span class="cell-num tnum" class:today-num={sameDay(day, nowTick)}>{day.getDate()}</span>
								{#each evs.slice(0, 3) as ev (ev.objectId + '-' + ev.start)}
									<button class="month-ev trunc" style="--ev-color: {calColor(ev)}" onclick={() => openEditor(ev)}>
										{#if !ev.allDay}<span class="ev-time tnum">{fmtTime(ev.start, data.settings.timeFormat)}</span>{/if}
										{ev.summary || '(untitled)'}
									</button>
								{/each}
								{#if evs.length > 3}
									<button class="more-ev" onclick={() => { cursor = day; view = 'day'; }}>+{evs.length - 3} more</button>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			</div>

		{:else if view === 'week' || view === 'day'}
			<div class="tgrid-wrap">
				<!-- all-day row -->
				<div class="allday-row">
					<div class="gutter-spacer"></div>
					{#each weekDays as day (day.getTime())}
						{@const ads = allDayOn(day)}
						<div class="allday-cell" class:today-col={sameDay(day, nowTick)}>
							{#each ads as ev (ev.objectId + '-' + ev.start)}
								<button class="allday-ev trunc" style="--ev-color: {calColor(ev)}" onclick={() => openEditor(ev)}>{ev.summary || '(untitled)'}</button>
							{/each}
						</div>
					{/each}
				</div>
				<!-- day headers -->
				<div class="dow-row">
					<div class="gutter-spacer"></div>
					{#each weekDays as day (day.getTime())}
						<button class="dow-cell" class:today-col={sameDay(day, nowTick)} onclick={() => { cursor = day; view = 'day'; }}>
							<span class="dow-name">{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
							<span class="dow-num tnum" class:today-num={sameDay(day, nowTick)}>{day.getDate()}</span>
						</button>
					{/each}
				</div>
				<!-- time grid -->
				<div class="tgrid">
					<div class="gutter">
						{#each hours as h (h)}
							<div class="hour-lbl tnum" style="top: {h * HOUR_PX}px">
								{h === 0 ? '' : data.settings.timeFormat === '24' ? `${String(h).padStart(2, '0')}:00` : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`}
							</div>
						{/each}
					</div>
					{#each weekDays as day (day.getTime())}
						{@const placed = layoutDay(timedOn(day))}
						<div
							class="day-col"
							data-day={startOfDay(day).getTime()}
							style="height: {24 * HOUR_PX}px"
							onpointerdown={(e) => gridPointerDown(e, day)}
						>
							{#each hours as h (h)}
								<div class="hour-line" style="top: {h * HOUR_PX}px"></div>
							{/each}
							{#if sameDay(day, nowTick)}
								<div class="now-line" style="top: {nowOffset}px"><span class="now-dot"></span></div>
							{/if}
							{#each placed as ev (ev.objectId + '-' + ev.start)}
								{@const hidden = dragPreview && drag?.ev && drag.ev.objectId === ev.objectId && drag.ev.start === ev.start}
								{#if !hidden}
									<div
										class="event-block"
										style="top: {evTop(ev, day)}px; height: {evHeight(ev, day)}px; left: calc({(ev.col / ev.cols) * 100}% + 2px); width: calc({100 / ev.cols}% - 4px); --ev-color: {calColor(ev)}"
										role="button" tabindex="0"
										onpointerdown={(e) => evPointerDown(e, ev, day)}
										onkeydown={(e) => { if (e.key === 'Enter') openEditor(ev); }}
									>
										<span class="eb-title trunc">{ev.summary || '(untitled)'}</span>
										<span class="eb-time tnum">{fmtTime(ev.start, data.settings.timeFormat)}</span>
										{#if videoRe.test(ev.location + ' ' + (ev.description ?? ''))}
											<a class="eb-join" href={(ev.location + ' ' + (ev.description ?? '')).match(videoRe)?.[0]} target="_blank" rel="noopener noreferrer" onpointerdown={(e) => e.stopPropagation()}>Join</a>
										{/if}
										<div class="resize-handle" onpointerdown={(e) => evPointerDown(e, ev, day, true)}></div>
									</div>
								{/if}
							{/each}
							{#if dragPreview && sameDay(dragPreview.day, day)}
								<div class="event-block preview" style="top: {evTop(dragPreview as unknown as Ev, day)}px; height: {evHeight(dragPreview as unknown as Ev, day)}px; left: 2px; right: 2px; --ev-color: var(--accent)">
									<span class="eb-time tnum">{fmtTime(dragPreview.start, data.settings.timeFormat)} – {fmtTime(dragPreview.end, data.settings.timeFormat)}</span>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>

		{:else}
			<!-- agenda -->
			<div class="agenda">
				{#if agendaDays.length === 0}
					<div class="agenda-empty">
						<div class="empty-art">🗓</div>
						<p>Nothing scheduled in the next 30 days.</p>
					</div>
				{/if}
				{#each agendaDays as { day, evs } (day.getTime())}
					<div class="agenda-day">
						<div class="agenda-date" class:today-num={sameDay(day, nowTick)}>
							<span class="ad-dow">{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
							<span class="ad-num tnum">{day.getDate()}</span>
							<span class="ad-mon">{day.toLocaleDateString(undefined, { month: 'short' })}</span>
						</div>
						<div class="agenda-evs">
							{#each evs as ev (ev.objectId + '-' + ev.start)}
								<button class="agenda-ev" style="--ev-color: {calColor(ev)}" onclick={() => openEditor(ev)}>
									<span class="ae-time tnum">{ev.allDay ? 'All day' : `${fmtTime(ev.start, data.settings.timeFormat)} – ${fmtTime(ev.end, data.settings.timeFormat)}`}</span>
									<span class="ae-title">{ev.summary || '(untitled)'}</span>
									{#if ev.location}<span class="ae-loc trunc">📍 {ev.location}</span>{/if}
								</button>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</div>

<!-- quick create popover -->
{#if quickCreate}
	<div class="qc-overlay" role="presentation" onclick={() => (quickCreate = null)} onkeydown={(e) => { if (e.key === 'Escape') quickCreate = null; }}>
		<div class="qc glass" style="left: {quickCreate.x}px; top: {quickCreate.y}px" role="dialog" aria-label="Quick create event" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="input" type="text" autofocus
				placeholder='Try “Lunch with Sam tomorrow 1pm”'
				bind:value={quickText}
				onkeydown={(e) => { if (e.key === 'Enter') void submitQuickCreate(); if (e.key === 'Escape') quickCreate = null; }}
				aria-label="Quick event text"
			/>
			<div class="qc-foot">
				<span class="qc-hint tnum">{new Date(quickCreate.start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
				<button class="btn btn-ghost" onclick={() => { const qcv = quickCreate!; quickCreate = null; newEventAt(qcv.start, qcv.end); }}>More options</button>
				<button class="btn btn-primary" onclick={() => void submitQuickCreate()}>Create</button>
			</div>
		</div>
	</div>
{/if}

{#if editing}
	<EventEditor
		event={editing}
		calendars={calendars.filter((c) => c.supports_vevent)}
		profileId={data.profile.id}
		{organizerEmail}
		onsaved={() => { editing = null; void loadEvents(); }}
		onclose={() => (editing = null)}
	/>
{/if}

<style>
	.cal-page { display: flex; height: 100%; min-height: 0; overflow: hidden; }
	.cal-side {
		width: 240px; flex: none;
		border-right: 1px solid var(--border);
		padding: 14px;
		display: flex; flex-direction: column; gap: 16px;
		overflow-y: auto;
	}
	.new-btn { width: 100%; }
	.mini-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
	.mini-title { font-size: 13px; font-weight: 640; font-family: var(--font-display); }
	.mini-nav { background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 14px; padding: 2px 8px; border-radius: var(--r-1); }
	.mini-nav:hover { background: var(--surface-2); color: var(--text-1); }
	.mini-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px; }
	.mini-dow { font-size: 10px; color: var(--text-3); text-align: center; padding: 3px 0; }
	.mini-day {
		aspect-ratio: 1; border: none; background: none;
		font-size: 11.5px; color: var(--text-2); cursor: pointer;
		border-radius: 50%; font-family: inherit;
	}
	.mini-day:hover { background: var(--surface-2); }
	.mini-day.dim { color: var(--text-3); opacity: 0.5; }
	.mini-day.today { font-weight: 700; color: var(--accent); }
	.mini-day.sel { background: var(--accent); color: var(--accent-contrast); }
	.cal-list-head { display: flex; align-items: center; justify-content: space-between; }
	.cal-list h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); margin: 0 0 6px; }
	.cal-empty { font-size: 12.5px; color: var(--text-3); }
	.cal-empty a { color: var(--accent); }
	.cal-item { display: flex; align-items: center; gap: 8px; padding: 5px 2px; font-size: 13px; cursor: pointer; }
	.cal-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
	.cal-name { min-width: 0; flex: 1; }
	.cal-def { font-size: 10px; color: var(--text-3); border: 1px solid var(--border); border-radius: 99px; padding: 1px 6px; }

	.cal-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
	.cal-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
	.cal-title { font-family: var(--font-display); font-size: 19px; font-weight: 640; margin: 0 0 0 6px; }
	.nav-arrow { background: none; border: 1px solid var(--border); border-radius: var(--r-1); color: var(--text-2); width: 28px; height: 28px; cursor: pointer; font-size: 15px; }
	.nav-arrow:hover { background: var(--surface-2); }
	.grow { flex: 1; }
	.spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--border); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.view-tabs { display: flex; gap: 2px; background: var(--surface-2); border-radius: 99px; padding: 3px; }
	.view-tabs button {
		background: none; border: none; cursor: pointer;
		font-family: inherit; font-size: 12.5px; color: var(--text-3);
		padding: 5px 12px; border-radius: 99px;
		transition: all var(--dur-1);
	}
	.view-tabs button.on { background: var(--surface-0); color: var(--text-1); font-weight: 600; box-shadow: var(--shadow-1); }

	/* month */
	.month-grid { flex: 1; display: flex; flex-direction: column; min-height: 0; }
	.month-dows { display: grid; grid-template-columns: repeat(7, 1fr); padding: 6px 0; border-bottom: 1px solid var(--border); }
	.month-dows span { text-align: center; font-size: 11.5px; color: var(--text-3); }
	.month-week { flex: 1; display: grid; grid-template-columns: repeat(7, 1fr); min-height: 0; }
	.month-cell {
		border-right: 1px solid color-mix(in oklab, var(--border) 55%, transparent);
		border-bottom: 1px solid color-mix(in oklab, var(--border) 55%, transparent);
		padding: 4px; overflow: hidden;
		display: flex; flex-direction: column; gap: 2px;
		cursor: pointer; min-height: 0;
	}
	.month-cell.dim { background: color-mix(in oklab, var(--surface-1) 40%, transparent); }
	.month-cell.dim .cell-num { opacity: 0.45; }
	.cell-num { font-size: 12px; color: var(--text-2); padding: 2px 4px; align-self: flex-start; }
	.today-num { background: var(--accent); color: var(--accent-contrast) !important; border-radius: 99px; font-weight: 700; }
	.month-ev {
		display: flex; gap: 4px; align-items: baseline;
		background: color-mix(in oklab, var(--ev-color) 18%, transparent);
		border: none; border-left: 3px solid var(--ev-color);
		border-radius: 4px; padding: 1px 6px;
		font-family: inherit; font-size: 11.5px; color: var(--text-1);
		cursor: pointer; text-align: left; width: 100%;
	}
	.ev-time { color: var(--text-3); font-size: 10.5px; flex: none; }
	.more-ev { background: none; border: none; font-size: 11px; color: var(--text-3); cursor: pointer; text-align: left; padding: 0 6px; font-family: inherit; }
	.more-ev:hover { color: var(--accent); }

	/* week/day time grid */
	.tgrid-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
	.allday-row, .dow-row { display: flex; flex: none; border-bottom: 1px solid var(--border); }
	.dow-row { position: sticky; top: 0; z-index: 20; background: var(--bg); }
	.gutter-spacer { width: 56px; flex: none; }
	.allday-cell { flex: 1; min-width: 0; padding: 2px 3px; display: flex; flex-direction: column; gap: 2px; border-left: 1px solid color-mix(in oklab, var(--border) 50%, transparent); }
	.allday-ev {
		background: color-mix(in oklab, var(--ev-color) 22%, transparent);
		border: none; border-left: 3px solid var(--ev-color);
		border-radius: 4px; padding: 2px 6px;
		font-family: inherit; font-size: 11.5px; color: var(--text-1);
		cursor: pointer; text-align: left;
	}
	.dow-cell {
		flex: 1; display: flex; flex-direction: column; align-items: center; gap: 1px;
		background: none; border: none; border-left: 1px solid color-mix(in oklab, var(--border) 50%, transparent);
		padding: 6px 0; cursor: pointer; font-family: inherit;
	}
	.dow-name { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.04em; }
	.dow-num { font-size: 16px; font-weight: 640; color: var(--text-1); padding: 1px 8px; border-radius: 99px; }
	.tgrid { display: flex; position: relative; }
	.gutter { width: 56px; flex: none; position: relative; height: calc(24 * 48px); }
	.hour-lbl { position: absolute; right: 8px; transform: translateY(-50%); font-size: 10.5px; color: var(--text-3); }
	.day-col {
		flex: 1; min-width: 0; position: relative;
		border-left: 1px solid color-mix(in oklab, var(--border) 50%, transparent);
		touch-action: pan-y;
	}
	.hour-line { position: absolute; left: 0; right: 0; height: 1px; background: color-mix(in oklab, var(--border) 45%, transparent); }
	.now-line { position: absolute; left: 0; right: 0; height: 2px; background: var(--danger); z-index: 15; pointer-events: none; }
	.now-dot { position: absolute; left: -4px; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
	.event-block {
		position: absolute; z-index: 10;
		background: color-mix(in oklab, var(--ev-color) 24%, var(--surface-0));
		border-left: 3px solid var(--ev-color);
		border-radius: 6px;
		padding: 3px 6px;
		overflow: hidden;
		cursor: grab;
		font-size: 11.5px;
		display: flex; flex-direction: column;
		box-shadow: var(--shadow-1);
		user-select: none;
	}
	.event-block:active { cursor: grabbing; }
	.event-block.preview { opacity: 0.75; border-style: dashed; pointer-events: none; z-index: 30; }
	.eb-title { font-weight: 620; color: var(--text-1); }
	.eb-time { color: var(--text-3); font-size: 10.5px; }
	.eb-join {
		margin-top: auto; align-self: flex-start;
		background: var(--ev-color); color: white;
		font-size: 10.5px; font-weight: 600;
		padding: 1px 8px; border-radius: 99px;
		text-decoration: none;
	}
	.resize-handle { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; cursor: ns-resize; }
	.today-col { background: color-mix(in oklab, var(--accent) 4%, transparent); }

	/* agenda */
	.agenda { flex: 1; overflow-y: auto; padding: 16px; }
	.agenda-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 60px 0; color: var(--text-3); }
	.empty-art { font-size: 40px; }
	.agenda-day { display: flex; gap: 16px; margin-bottom: 18px; }
	.agenda-date { width: 56px; flex: none; text-align: center; display: flex; flex-direction: column; }
	.ad-dow { font-size: 11px; color: var(--text-3); text-transform: uppercase; }
	.ad-num { font-family: var(--font-display); font-size: 22px; font-weight: 640; }
	.ad-mon { font-size: 11px; color: var(--text-3); }
	.agenda-evs { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
	.agenda-ev {
		display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap;
		background: var(--surface-1);
		border: 1px solid var(--border); border-left: 3px solid var(--ev-color);
		border-radius: var(--r-2); padding: 10px 14px;
		font-family: inherit; cursor: pointer; text-align: left;
		transition: background var(--dur-1);
	}
	.agenda-ev:hover { background: var(--surface-2); }
	.ae-time { font-size: 12px; color: var(--text-3); width: 130px; flex: none; }
	.ae-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
	.ae-loc { font-size: 12px; color: var(--text-3); }

	.qc-overlay { position: fixed; inset: 0; z-index: 900; }
	.qc {
		position: fixed; z-index: 901;
		width: 320px;
		border-radius: var(--r-2); padding: 12px;
		box-shadow: var(--shadow-3);
		animation: pop-in var(--dur-2) var(--ease-spring);
	}
	@keyframes pop-in { from { opacity: 0; transform: scale(0.96); } }
	.qc .input { width: 100%; }
	.qc-foot { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
	.qc-hint { flex: 1; font-size: 11.5px; color: var(--text-3); }

	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	@media (max-width: 900px) {
		.cal-side { display: none; }
		.ae-time { width: auto; }
	}
	@media (prefers-reduced-motion: reduce) { .qc { animation: none; } }
</style>
