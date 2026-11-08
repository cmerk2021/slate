<script lang="ts">
	import { apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let timezone = $state(data.settings.timezone);
	let timeFormat = $state(data.settings.timeFormat);
	let weekStart = $state(String(data.settings.weekStart));
	let defaultView = $state(data.settings.defaultView);
	let density = $state(data.settings.density);
	let shortcutsEnabled = $state(data.settings.shortcutsEnabled);

	const timezones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [Intl.DateTimeFormat().resolvedOptions().timeZone];

	async function save(settings: Record<string, string>) {
		try {
			await apiPost('/api/settings', { action: 'set', settings });
			await invalidateAll();
			toasts.success('Saved');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}
</script>

<svelte:head><title>Settings · General — Slate</title></svelte:head>

<h2>General</h2>
<p class="s-sub">Time, language, and layout basics.</p>

<div class="s-section">
	<div class="s-row">
		<div><div class="s-row-label">Timezone</div><div class="s-row-help">Used for calendar and date display</div></div>
		<select class="input" bind:value={timezone} onchange={() => void save({ timezone })}>
			{#each timezones as tz (tz)}<option value={tz}>{tz}</option>{/each}
		</select>
	</div>
	<div class="s-row">
		<div class="s-row-label">Time format</div>
		<select class="input" bind:value={timeFormat} onchange={() => void save({ time_format: timeFormat })}>
			<option value="12">12-hour (1:30 PM)</option>
			<option value="24">24-hour (13:30)</option>
		</select>
	</div>
	<div class="s-row">
		<div class="s-row-label">Week starts on</div>
		<select class="input" bind:value={weekStart} onchange={() => void save({ week_start: weekStart })}>
			<option value="1">Monday</option>
			<option value="0">Sunday</option>
			<option value="6">Saturday</option>
		</select>
	</div>
	<div class="s-row">
		<div><div class="s-row-label">Default landing view</div><div class="s-row-help">Where the app opens</div></div>
		<select class="input" bind:value={defaultView} onchange={() => void save({ default_view: defaultView })}>
			<option value="today">Today</option>
			<option value="mail">Mail</option>
			<option value="calendar">Calendar</option>
			<option value="tasks">Tasks</option>
		</select>
	</div>
	<div class="s-row">
		<div class="s-row-label">Density</div>
		<select class="input" bind:value={density} onchange={() => void save({ density })}>
			<option value="comfortable">Comfortable</option>
			<option value="compact">Compact</option>
		</select>
	</div>
	<div class="s-row">
		<div><div class="s-row-label">Keyboard shortcuts</div><div class="s-row-help">Press ? to view the cheat sheet</div></div>
		<input type="checkbox" bind:checked={shortcutsEnabled} onchange={() => void save({ shortcuts_enabled: shortcutsEnabled ? '1' : '0' })} aria-label="Enable keyboard shortcuts" />
	</div>
</div>
