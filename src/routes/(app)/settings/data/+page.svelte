<script lang="ts">
	import { onMount } from 'svelte';
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { fmtBytes } from '$lib/client/format';

	let cacheBytes = $state(0);
	let cacheMaxMb = $state(0);
	let version = $state('');
	let appName = $state('Slate');

	async function load() {
		const d = await apiGet<{ cacheBytes: number; cacheMaxMb: number; version: string; app: string }>('/api/settings?view=data');
		cacheBytes = d.cacheBytes; cacheMaxMb = d.cacheMaxMb; version = d.version; appName = d.app;
	}
	onMount(() => void load());

	async function clearCache() {
		if (!confirm('Clear the local body/attachment cache? Messages will re-download on demand.')) return;
		try {
			await apiPost('/api/settings', { action: 'clear-cache' });
			await load();
			toasts.success('Cache cleared');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not clear cache');
		}
	}

	async function exportConfig() {
		try {
			const data = await apiGet<Record<string, unknown>>('/api/settings?view=export');
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `slate-config-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Export failed');
		}
	}
</script>

<svelte:head><title>Settings · Data — Slate</title></svelte:head>

<h2>Data</h2>
<p class="s-sub">Cache, export, and about.</p>

<div class="s-section">
	<div class="s-row">
		<div><div class="s-row-label">Body & attachment cache</div><div class="s-row-help">{fmtBytes(cacheBytes)} of {cacheMaxMb} MB cap (LRU, evicted automatically)</div></div>
		<button class="btn" onclick={() => void clearCache()}>Clear cache</button>
	</div>
	<div class="s-row">
		<div><div class="s-row-label">Export configuration</div><div class="s-row-help">Profiles, accounts, and settings as JSON — never includes passwords or secrets</div></div>
		<button class="btn" onclick={() => void exportConfig()}>Export JSON</button>
	</div>
	<div class="s-row">
		<div><div class="s-row-label">Backups</div><div class="s-row-help">Backing up the /data volume captures everything: database, cache, and keys</div></div>
	</div>
	<div class="s-row">
		<div><div class="s-row-label">About</div><div class="s-row-help">{appName} v{version} — self-hosted mail, calendar, contacts & tasks</div></div>
	</div>
</div>
