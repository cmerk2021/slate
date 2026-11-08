<script lang="ts">
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const sections = [
		{ slug: 'general', label: 'General', icon: '⚙️' },
		{ slug: 'profiles', label: 'Profiles', icon: '🎭' },
		{ slug: 'accounts', label: 'Accounts', icon: '🔌' },
		{ slug: 'appearance', label: 'Appearance', icon: '🎨' },
		{ slug: 'mail', label: 'Mail', icon: '✉️' },
		{ slug: 'calendar', label: 'Calendar & Tasks', icon: '🗓' },
		{ slug: 'security', label: 'Security', icon: '🔐' },
		{ slug: 'shortcuts', label: 'Shortcuts', icon: '⌨️' },
		{ slug: 'data', label: 'Data', icon: '💾' }
	];

	const current = $derived(page.url.pathname.split('/')[2] ?? 'general');
</script>

<div class="settings-page">
	<nav class="s-nav" aria-label="Settings sections">
		<h1>Settings</h1>
		{#each sections as s (s.slug)}
			<a href="/settings/{s.slug}" class="s-link" class:on={current === s.slug}>
				<span class="s-ico">{s.icon}</span>{s.label}
			</a>
		{/each}
	</nav>
	<main class="s-content">
		{@render children()}
	</main>
</div>

<style>
	.settings-page { display: flex; height: 100%; min-height: 0; }
	.s-nav {
		width: 220px; flex: none;
		border-right: 1px solid var(--border);
		padding: 18px 10px;
		display: flex; flex-direction: column; gap: 2px;
		overflow-y: auto;
	}
	.s-nav h1 { font-family: var(--font-display); font-size: 18px; margin: 0 10px 12px; }
	.s-link {
		display: flex; align-items: center; gap: 9px;
		color: var(--text-2); text-decoration: none;
		font-size: 13.5px;
		padding: 8px 10px; border-radius: var(--r-2);
		transition: background var(--dur-1);
	}
	.s-link:hover { background: var(--surface-2); color: var(--text-1); }
	.s-link.on { background: color-mix(in oklab, var(--accent) 14%, transparent); color: var(--accent); font-weight: 600; }
	.s-ico { font-size: 14px; }
	.s-content { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 28px 60px; }
	.s-content :global(h2) { font-family: var(--font-display); font-size: 21px; margin: 0 0 4px; }
	.s-content :global(.s-sub) { color: var(--text-3); font-size: 13px; margin: 0 0 22px; }
	.s-content :global(.s-section) { max-width: 640px; margin-bottom: 28px; }
	.s-content :global(.s-row) {
		display: flex; align-items: center; justify-content: space-between; gap: 16px;
		padding: 12px 0;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
	}
	.s-content :global(.s-row-label) { font-size: 13.5px; color: var(--text-1); }
	.s-content :global(.s-row-help) { font-size: 12px; color: var(--text-3); margin-top: 2px; }
	.s-content :global(h3) { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); margin: 24px 0 4px; }
	@media (max-width: 760px) {
		.settings-page { flex-direction: column; }
		.s-nav { width: 100%; flex-direction: row; flex-wrap: wrap; border-right: none; border-bottom: 1px solid var(--border); }
		.s-nav h1 { width: 100%; }
	}
</style>
