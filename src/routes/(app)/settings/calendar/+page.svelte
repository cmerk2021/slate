<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';

	let { data } = $props();

	interface Cal { id: number; name: string; color: string | null; is_default: number; supports_vevent: number }
	let calendars = $state<Cal[]>([]);
	let lists = $state<{ id: number; name: string }[]>([]);

	async function load() {
		try {
			const [c, l] = await Promise.all([
				apiGet<{ calendars: Cal[] }>(`/api/calendar?profile=${data.profile.id}&view=calendars`),
				apiGet<{ lists: { id: number; name: string }[] }>(`/api/tasks?profile=${data.profile.id}&view=lists`)
			]);
			calendars = c.calendars;
			lists = l.lists;
		} catch { /* no caldav yet */ }
	}
	$effect(() => { void data.profile.id; void load(); });

	async function setDefault(calendarId: number) {
		try {
			await apiPost('/api/calendar', { action: 'set-default', calendarId, profileId: data.profile.id });
			await load();
			toasts.success('Default calendar updated');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}

	async function setColor(calendarId: number, color: string) {
		try {
			await apiPost('/api/calendar', { action: 'set-color', calendarId, color });
			await load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}
</script>

<svelte:head><title>Settings · Calendar & Tasks — Slate</title></svelte:head>

<h2>Calendar & Tasks</h2>
<p class="s-sub">Defaults for the current profile ({data.profile.name}).</p>

<div class="s-section">
	<h3>Calendars</h3>
	{#if calendars.length === 0}
		<p class="s-row-help">No CalDAV calendars connected yet. <a href="/settings/accounts">Add one</a>.</p>
	{/if}
	{#each calendars as c (c.id)}
		<div class="s-row">
			<div class="cal-id">
				<input class="color" type="color" value={c.color ?? '#e08856'} onchange={(e) => void setColor(c.id, (e.target as HTMLInputElement).value)} aria-label="Calendar color" />
				<span class="s-row-label">{c.name}</span>
			</div>
			{#if c.is_default}
				<span class="pill on">Default for new events</span>
			{:else}
				<button class="btn" onclick={() => void setDefault(c.id)}>Make default</button>
			{/if}
		</div>
	{/each}

	<h3>Task lists</h3>
	{#if lists.length === 0}
		<p class="s-row-help">No VTODO-capable lists found.</p>
	{/if}
	{#each lists as l (l.id)}
		<div class="s-row"><span class="s-row-label">{l.name}</span></div>
	{/each}

	<h3>Reminders</h3>
	<p class="s-row-help">Event reminders (VALARM) fire as in-app toasts, and as browser notifications when enabled under Settings → Mail.</p>
</div>

<style>
	.cal-id { display: flex; align-items: center; gap: 10px; }
	.color { width: 28px; height: 28px; border: none; background: none; padding: 0; cursor: pointer; border-radius: 6px; }
	.pill { font-size: 12px; color: var(--text-3); border: 1px solid var(--border); border-radius: 99px; padding: 3px 10px; }
	.pill.on { color: var(--accent); border-color: var(--accent); }
	a { color: var(--accent); }
</style>
