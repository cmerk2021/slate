<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { fmtTime, startOfDay } from '$lib/client/format';
	import { sse } from '$lib/client/sse.svelte';
	import { toasts } from '$lib/client/toasts.svelte';
	import { goto } from '$app/navigation';
	import { APP_NAME } from '$lib/config';
	import type { LayoutData } from '../$types';

	let { data }: { data: LayoutData } = $props();

	interface TodayEvent { summary: string; start: number; end: number; allDay: boolean; color: string | null; location: string; objectId: number; calendarId: number }
	interface TodayMail { id: number; folderId: number; subject: string; from: { name: string; address: string }[]; snippet: string; date: number }
	interface TodayTask { id: number; calendar_id: number; summary: string; due: number; priority: number | null; color: string | null }

	interface TodayData {
		events: TodayEvent[];
		unread: TodayMail[];
		unreadTotal: number;
		tasks: TodayTask[];
		snoozed: TodayMail[];
	}

	let today = $state<TodayData | null>(null);
	let error = $state('');
	let nowMs = $state(Date.now());
	let quickTask = $state('');
	let taskLists = $state<{ id: number; name: string }[]>([]);

	async function load() {
		try {
			today = await apiGet<TodayData>(`/api/today?profile=${data.profile.id}&dayStart=${startOfDay()}`);
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load Today';
		}
	}

	$effect(() => {
		void data.profile.id;
		void load();
		void apiGet<{ lists: { id: number; name: string }[] }>(`/api/tasks?profile=${data.profile.id}&view=lists`).then((r) => (taskLists = r.lists)).catch(() => {});
		const offs = [
			sse.on('mail', () => void load()),
			sse.on('calendar', () => void load()),
			sse.on('tasks', () => void load()),
			sse.on('snooze-wake', () => void load())
		];
		const timer = setInterval(() => (nowMs = Date.now()), 60_000);
		return () => { offs.forEach((o) => o()); clearInterval(timer); };
	});

	const greeting = $derived.by(() => {
		const h = new Date(nowMs).getHours();
		if (h < 5) return 'Good night';
		if (h < 12) return 'Good morning';
		if (h < 18) return 'Good afternoon';
		return 'Good evening';
	});

	const dateLine = $derived(
		new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(nowMs))
	);

	const summaryLine = $derived.by(() => {
		if (!today) return '';
		const parts: string[] = [];
		parts.push(`${today.events.length} event${today.events.length === 1 ? '' : 's'}`);
		parts.push(`${today.unreadTotal} unread`);
		const due = today.tasks.length;
		parts.push(`${due} task${due === 1 ? '' : 's'} due`);
		return parts.join(' · ');
	});

	const nextUp = $derived.by(() => {
		if (!today) return null;
		return today.events.find((e) => !e.allDay && e.start > nowMs) ?? null;
	});

	function videoLink(ev: TodayEvent): string | null {
		const text = `${ev.location} ${ev.summary}`;
		const m = text.match(/https?:\/\/[^\s]*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com|whereby\.com)[^\s]*/i);
		return m ? m[0] : null;
	}

	async function mailAction(m: TodayMail, action: 'archive' | 'snooze') {
		if (!today) return;
		const prev = today.unread;
		today.unread = today.unread.filter((x) => x.id !== m.id);
		today.unreadTotal = Math.max(0, today.unreadTotal - 1);
		try {
			if (action === 'archive') {
				await apiPost('/api/mail', { action: 'archive', ids: [m.id] });
				toasts.undoable('Archived', {
					onUndo: async () => { await apiPost('/api/mail', { action: 'move', ids: [m.id], role: 'inbox' }); void load(); }
				});
			} else {
				const tomorrow9 = new Date(); tomorrow9.setDate(tomorrow9.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
				await apiPost('/api/mail', { action: 'snooze', ids: [m.id], until: tomorrow9.getTime() });
				toasts.undoable('Snoozed until tomorrow 9am', {
					onUndo: async () => { await apiPost('/api/mail', { action: 'unsnooze', ids: [m.id] }); void load(); }
				});
			}
		} catch (e) {
			today.unread = prev;
			toasts.error(e instanceof Error ? e.message : 'Action failed');
		}
	}

	async function makeTask(m: TodayMail) {
		if (taskLists.length === 0) { toasts.error('No task list connected. Add a CalDAV account first.'); return; }
		try {
			await apiPost('/api/tasks', {
				action: 'create',
				calendarId: taskLists[0].id,
				summary: m.subject || 'Follow up',
				description: `From: ${m.from[0]?.name || m.from[0]?.address}\nOpen in ${APP_NAME}: /mail?message=${m.id}`
			});
			toasts.success('Task created');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed to create task');
		}
	}

	async function completeTask(t: TodayTask) {
		if (!today) return;
		const prev = today.tasks;
		today.tasks = today.tasks.filter((x) => x.id !== t.id);
		try {
			await apiPost('/api/tasks', { action: 'toggle', calendarId: t.calendar_id, taskId: t.id, completed: true });
		} catch (e) {
			today.tasks = prev;
			toasts.error(e instanceof Error ? e.message : 'Failed');
		}
	}

	async function rescheduleTask(t: TodayTask) {
		const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(17, 0, 0, 0);
		if (!today) return;
		today.tasks = today.tasks.filter((x) => x.id !== t.id);
		try {
			await apiPost('/api/tasks', { action: 'update', calendarId: t.calendar_id, taskId: t.id, summary: t.summary, due: tomorrow.getTime() });
			toasts.success('Moved to tomorrow');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed');
			void load();
		}
	}

	async function addQuickTask() {
		const text = quickTask.trim();
		if (!text) return;
		if (taskLists.length === 0) { toasts.error('No task list connected.'); return; }
		quickTask = '';
		try {
			await apiPost('/api/tasks', { action: 'quick-add', calendarId: taskLists[0].id, text });
			toasts.success('Task added');
			void load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed');
		}
	}

	const dayStartMs = $derived(startOfDay(new Date(nowMs)));
</script>

<svelte:head><title>Today · {APP_NAME}</title></svelte:head>

<div class="today-page">
	<header class="hero">
		<h1>{greeting}</h1>
		<p class="date-line">{dateLine}{#if summaryLine}<span class="sep">·</span>{summaryLine}{/if}</p>
	</header>

	{#if error}
		<div class="card err-card">
			<p>{error}</p>
			<button class="btn" onclick={load}>Retry</button>
		</div>
	{:else if !today}
		<div class="cols">
			<div class="skeleton" style="height: 220px"></div>
			<div class="skeleton" style="height: 220px"></div>
			<div class="skeleton" style="height: 220px"></div>
		</div>
	{:else}
		<div class="cols">
			<!-- events timeline -->
			<section class="card col" aria-label="Today's events">
				<h2>Schedule</h2>
				{#if today.events.length === 0}
					<div class="empty">
						<span class="empty-glyph">🌤</span>
						<p>A clear day. Nothing scheduled.</p>
					</div>
				{:else}
					<div class="timeline">
						{#each today.events as ev (ev.objectId + '-' + ev.start)}
							{@const isNow = !ev.allDay && ev.start <= nowMs && ev.end > nowMs}
							{@const isNext = nextUp === ev}
							{@const vlink = videoLink(ev)}
							<div class="tl-item" class:now={isNow} class:next={isNext}>
								<span class="tl-time tnum">{ev.allDay ? 'All day' : fmtTime(ev.start, data.settings.timeFormat)}</span>
								<span class="tl-rail"><span class="tl-dot" style="background: {ev.color ?? 'var(--accent)'}"></span></span>
								<div class="tl-body">
									<span class="tl-title">{ev.summary || '(untitled)'}</span>
									{#if ev.location && !vlink}
										<button class="tl-loc" title="Copy location" onclick={() => { navigator.clipboard.writeText(ev.location); toasts.success('Location copied'); }}>{ev.location}</button>
									{/if}
									{#if vlink}
										<a class="btn btn-primary join-btn" href={vlink} target="_blank" rel="noopener noreferrer">Join</a>
									{/if}
									{#if isNow}<span class="chip-now">happening now</span>{/if}
									{#if isNext}<span class="chip-next">up next</span>{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- unread mail -->
			<section class="card col" aria-label="Unread email">
				<h2>Unread <span class="count tnum">{today.unreadTotal}</span></h2>
				{#if today.unread.length === 0}
					<div class="empty">
						<span class="empty-glyph">🎉</span>
						<p>Inbox zero. Enjoy the quiet.</p>
					</div>
				{:else}
					{#each today.unread as m (m.id)}
						<div class="mail-row">
							<button class="mail-main" onclick={() => goto(`/mail?message=${m.id}`)}>
								<span class="mail-from">{m.from[0]?.name || m.from[0]?.address || 'Unknown'}</span>
								<span class="mail-subj">{m.subject || '(no subject)'}</span>
								<span class="mail-snippet">{m.snippet}</span>
							</button>
							<div class="mail-actions">
								<button class="icon-act" title="Archive (e)" onclick={() => mailAction(m, 'archive')}>🗂️</button>
								<button class="icon-act" title="Snooze (b)" onclick={() => mailAction(m, 'snooze')}>⏰</button>
								<button class="icon-act" title="Reply (r)" onclick={() => goto(`/mail?message=${m.id}&reply=1`)}>↩️</button>
								<button class="icon-act" title="Make task (t)" onclick={() => makeTask(m)}>✓</button>
							</div>
						</div>
					{/each}
				{/if}
			</section>

			<!-- tasks -->
			<section class="card col" aria-label="Tasks due">
				<h2>Tasks</h2>
				<form class="quick-add" onsubmit={(e) => { e.preventDefault(); void addQuickTask(); }}>
					<input class="input" type="text" bind:value={quickTask} placeholder={'Add a task… "pay rent friday !high"'} aria-label="Quick add task" />
				</form>
				{#if today.tasks.length === 0}
					<div class="empty">
						<span class="empty-glyph">🪺</span>
						<p>Nothing due. Add something above.</p>
					</div>
				{:else}
					{#each today.tasks as t (t.id)}
						<div class="task-row">
							<input type="checkbox" onchange={() => completeTask(t)} aria-label="Complete {t.summary}" />
							<span class="task-title" class:overdue={t.due < dayStartMs}>{t.summary}</span>
							{#if t.priority && t.priority <= 4}<span class="prio">!</span>{/if}
							<button class="icon-act" title="Move to tomorrow" onclick={() => rescheduleTask(t)}>→</button>
						</div>
					{/each}
				{/if}

				{#if today.snoozed.length > 0}
					<h2 class="snoozed-head">Snoozed returning today</h2>
					{#each today.snoozed as m (m.id)}
						<button class="mail-main compact" onclick={() => goto(`/mail?message=${m.id}`)}>
							<span class="mail-from">{m.from[0]?.name || m.from[0]?.address}</span>
							<span class="mail-subj">{m.subject || '(no subject)'}</span>
						</button>
					{/each}
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	.today-page {
		flex: 1; overflow-y: auto;
		padding: clamp(18px, 4vw, 42px);
	}
	.hero { margin-bottom: 26px; }
	h1 {
		font-family: var(--font-display);
		font-size: clamp(28px, 4.5vw, 40px);
		font-variation-settings: 'opsz' 40;
		margin: 0 0 6px;
		letter-spacing: -0.015em;
	}
	.date-line { color: var(--text-2); font-size: 14.5px; margin: 0; }
	.sep { margin: 0 8px; color: var(--text-3); }
	.cols {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 16px;
		align-items: start;
	}
	.col { padding: 20px; }
	h2 {
		font-family: var(--font-display); font-size: 16px; margin: 0 0 12px;
		display: flex; align-items: center; gap: 8px;
	}
	.count { background: var(--surface-2); border-radius: 99px; padding: 1px 8px; font-size: 11.5px; color: var(--text-2); font-family: var(--font-ui); }
	.empty { text-align: center; padding: 26px 10px; color: var(--text-3); }
	.empty-glyph { font-size: 30px; display: block; margin-bottom: 8px; }
	.empty p { font-size: 13.5px; margin: 0; }

	/* timeline */
	.timeline { display: flex; flex-direction: column; }
	.tl-item { display: flex; gap: 10px; padding: 7px 0; }
	.tl-time { width: 62px; flex: none; font-size: 12.5px; color: var(--text-3); padding-top: 2px; text-align: right; }
	.tl-rail { width: 14px; flex: none; display: flex; justify-content: center; position: relative; }
	.tl-rail::before { content: ''; position: absolute; top: 0; bottom: 0; width: 2px; background: var(--surface-2); border-radius: 2px; }
	.tl-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 4px; position: relative; z-index: 1; border: 2px solid var(--surface-0); }
	.tl-body { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
	.tl-title { font-weight: 560; font-size: 14px; }
	.tl-item.now .tl-title { color: var(--accent); }
	.tl-loc { background: none; border: none; color: var(--text-3); font-size: 12.5px; cursor: pointer; padding: 0; font-family: inherit; text-decoration: underline dotted; }
	.join-btn { padding: 3px 12px; font-size: 12.5px; }
	.chip-now, .chip-next {
		font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
		padding: 2px 8px; border-radius: 99px;
	}
	.chip-now { background: color-mix(in oklab, var(--accent) 20%, transparent); color: var(--accent); }
	.chip-next { background: var(--surface-2); color: var(--text-2); }

	/* mail rows */
	.mail-row { display: flex; align-items: stretch; gap: 4px; border-radius: var(--r-2); }
	.mail-row:hover { background: var(--surface-1); }
	.mail-row:hover .mail-actions { opacity: 1; }
	.mail-main {
		flex: 1; min-width: 0; text-align: left;
		background: none; border: none; cursor: pointer;
		font-family: inherit; color: var(--text-1);
		display: flex; flex-direction: column; gap: 1px;
		padding: 8px 10px;
	}
	.mail-main.compact { padding: 6px 10px; }
	.mail-from { font-weight: 600; font-size: 13.5px; }
	.mail-subj { font-size: 13px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mail-snippet { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mail-actions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity var(--dur-1); padding-right: 6px; }
	.icon-act {
		background: none; border: none; cursor: pointer;
		font-size: 13px; padding: 4px 5px; border-radius: var(--r-1);
		color: var(--text-2);
	}
	.icon-act:hover { background: var(--surface-2); }

	/* tasks */
	.quick-add { margin-bottom: 10px; }
	.task-row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: var(--r-2); }
	.task-row:hover { background: var(--surface-1); }
	.task-row:hover .icon-act { opacity: 1; }
	.task-row .icon-act { opacity: 0; margin-left: auto; }
	.task-title { font-size: 13.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.task-title.overdue { color: var(--danger); }
	.prio { color: var(--danger); font-weight: 700; }
	input[type='checkbox'] { accent-color: var(--accent); width: 15px; height: 15px; flex: none; }
	.snoozed-head { margin-top: 18px; }
	.err-card { padding: 20px; display: flex; align-items: center; gap: 14px; }
	.err-card p { margin: 0; color: var(--danger); }

	@media (max-width: 860px) {
		.today-page { padding-top: 58px; }
		.mail-actions { opacity: 1; }
		.task-row .icon-act { opacity: 1; }
	}
</style>
