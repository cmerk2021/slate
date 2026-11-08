<script lang="ts">
	import { apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();
	let enabled = $state(data.settings.shortcutsEnabled);

	const groups: { title: string; rows: [string, string][] }[] = [
		{ title: 'Global', rows: [['⌘/Ctrl K', 'Command palette'], ['⌘/Ctrl .', 'Today side panel'], ['⌘/Ctrl 1–9', 'Switch profile'], ['?', 'This cheat sheet'], ['z', 'Undo last action'], ['g then i/s/d/t/c', 'Go to inbox / sent / drafts / today / calendar']] },
		{ title: 'Mail list', rows: [['j / k', 'Next / previous message'], ['o or Enter', 'Open'], ['u', 'Back to list'], ['x', 'Select'], ['e', 'Archive'], ['#', 'Delete'], ['!', 'Mark spam'], ['s', 'Star'], ['b', 'Snooze'], ['Shift+I / Shift+U', 'Mark read / unread'], ['/', 'Search'], ['t', 'Create task from email']] },
		{ title: 'Message', rows: [['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['c', 'Compose new'], ['Esc', 'Close / back']] },
		{ title: 'Calendar', rows: [['m / w / d', 'Month / week / day view'], ['n', 'New event'], ['← / →', 'Previous / next period']] },
		{ title: 'Tasks', rows: [['n', 'New task'], ['Space', 'Complete selected'], ['j / k', 'Move selection'], ['#', 'Delete']] }
	];

	async function toggle() {
		try {
			await apiPost('/api/settings', { action: 'set', settings: { shortcuts_enabled: enabled ? '1' : '0' } });
			await invalidateAll();
			toasts.success(enabled ? 'Shortcuts enabled' : 'Shortcuts disabled');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}
</script>

<svelte:head><title>Settings · Shortcuts — Slate</title></svelte:head>

<h2>Keyboard shortcuts</h2>
<p class="s-sub">Shortcuts are disabled while typing in any input.</p>

<div class="s-section">
	<div class="s-row">
		<div class="s-row-label">Enable keyboard shortcuts</div>
		<input type="checkbox" bind:checked={enabled} onchange={() => void toggle()} aria-label="Enable shortcuts" />
	</div>

	{#each groups as g (g.title)}
		<h3>{g.title}</h3>
		{#each g.rows as [keys, desc] (keys)}
			<div class="s-row">
				<span class="s-row-label">{desc}</span>
				<span class="keys">
					{#each keys.split(' ') as k, i (i)}
						{#if k === 'then' || k === '/'}<span class="sep">{k}</span>{:else}<span class="kbd">{k}</span>{/if}
					{/each}
				</span>
			</div>
		{/each}
	{/each}
</div>

<style>
	.keys { display: flex; gap: 4px; align-items: center; }
	.sep { color: var(--text-3); font-size: 11px; }
</style>
