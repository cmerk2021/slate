<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { fmtTime, startOfDay } from '$lib/client/format';
	import { sse } from '$lib/client/sse.svelte';
	import { toasts } from '$lib/client/toasts.svelte';
	import { goto } from '$app/navigation';

	interface Props { profileId: number }
	let { profileId }: Props = $props();

	interface TodayData {
		events: { summary: string; start: number; end: number; allDay: boolean; color: string | null; location: string }[];
		unread: { id: number; subject: string; from: { name: string; address: string }[]; snippet: string }[];
		unreadTotal: number;
		tasks: { id: number; calendar_id: number; summary: string; due: number; color: string | null }[];
	}

	let data = $state<TodayData | null>(null);
	let error = $state('');

	async function load() {
		try {
			data = await apiGet<TodayData>(`/api/today?profile=${profileId}&dayStart=${startOfDay()}`);
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		}
	}

	$effect(() => {
		void profileId;
		void load();
		const offs = [
			sse.on('mail', () => void load()),
			sse.on('calendar', () => void load()),
			sse.on('tasks', () => void load())
		];
		return () => offs.forEach((off) => off());
	});

	async function completeTask(t: { id: number; calendar_id: number; summary: string }) {
		if (!data) return;
		data.tasks = data.tasks.filter((x) => x.id !== t.id);
		try {
			await apiPost('/api/tasks', { action: 'toggle', calendarId: t.calendar_id, taskId: t.id, completed: true });
			toasts.success(`Completed "${t.summary}"`);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Failed');
			void load();
		}
	}

	const now = Date.now();
</script>

<aside class="today-panel" aria-label="Today overview">
	<h2>Today</h2>
	{#if error}
		<p class="err">{error} <button class="btn btn-ghost" onclick={load}>Retry</button></p>
	{:else if !data}
		<div class="skeleton" style="height: 60px"></div>
		<div class="skeleton" style="height: 60px"></div>
	{:else}
		<section>
			<h3>Events</h3>
			{#if data.events.length === 0}
				<p class="muted">Nothing scheduled.</p>
			{:else}
				{#each data.events.slice(0, 6) as ev (ev.start + ev.summary)}
					<button class="item" onclick={() => goto('/calendar')}>
						<span class="dot" style="background: {ev.color ?? 'var(--accent)'}"></span>
						<span class="item-main">
							<span class="item-title">{ev.summary || '(untitled)'}</span>
							<span class="item-sub tnum">{ev.allDay ? 'All day' : fmtTime(ev.start)}</span>
						</span>
						{#if !ev.allDay && ev.start <= now && ev.end > now}<span class="badge">now</span>{/if}
					</button>
				{/each}
			{/if}
		</section>
		<section>
			<h3>Unread <span class="count tnum">{data.unreadTotal}</span></h3>
			{#if data.unread.length === 0}
				<p class="muted">Inbox zero ✨</p>
			{:else}
				{#each data.unread.slice(0, 6) as m (m.id)}
					<button class="item" onclick={() => goto(`/mail?message=${m.id}`)}>
						<span class="item-main">
							<span class="item-title">{m.from[0]?.name || m.from[0]?.address || 'Unknown'}</span>
							<span class="item-sub">{m.subject || '(no subject)'}</span>
						</span>
					</button>
				{/each}
			{/if}
		</section>
		<section>
			<h3>Tasks due</h3>
			{#if data.tasks.length === 0}
				<p class="muted">All clear.</p>
			{:else}
				{#each data.tasks.slice(0, 6) as t (t.id)}
					<div class="item task">
						<input type="checkbox" onchange={() => completeTask(t)} aria-label="Complete {t.summary}" />
						<span class="item-main">
							<span class="item-title" class:overdue={t.due < startOfDay()}>{t.summary}</span>
						</span>
					</div>
				{/each}
			{/if}
		</section>
	{/if}
</aside>

<style>
	.today-panel {
		width: 290px;
		flex: none;
		border-left: 1px solid var(--border);
		background: var(--surface-0);
		padding: 18px 16px;
		overflow-y: auto;
		animation: slide-in var(--dur-2) var(--ease-spring) both;
	}
	h2 { font-family: var(--font-display); font-size: 17px; margin: 0 0 12px; }
	h3 {
		font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--text-3); margin: 16px 0 6px;
		display: flex; align-items: center; gap: 6px;
	}
	.count {
		background: var(--surface-2); border-radius: 99px;
		padding: 0 7px; font-size: 11px; color: var(--text-2);
	}
	.item {
		display: flex; align-items: center; gap: 9px;
		width: 100%; text-align: left;
		background: none; border: none; cursor: pointer;
		padding: 7px 8px; border-radius: var(--r-2);
		color: var(--text-1); font-family: inherit; font-size: 13px;
		transition: background var(--dur-1);
	}
	.item:hover { background: var(--surface-1); }
	.item.task { cursor: default; }
	.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
	.item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
	.item-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 520; }
	.item-title.overdue { color: var(--danger); }
	.item-sub { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.muted { color: var(--text-3); font-size: 13px; margin: 2px 8px 6px; }
	.err { color: var(--danger); font-size: 13px; }
	input[type='checkbox'] { accent-color: var(--accent); }
	@keyframes slide-in { from { opacity: 0; transform: translateX(16px); } }
	@media (prefers-reduced-motion: reduce) { .today-panel { animation: none; } }
</style>
