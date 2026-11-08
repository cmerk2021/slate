<script lang="ts">
	import { apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	const themes = [
		{ id: 'zen-dark', label: 'Zen Dark', bg: '#1d1a19', fg: '#f0ebe5', accent: 'hsl(18 70% 62%)' },
		{ id: 'paper-light', label: 'Paper Light', bg: '#faf6f0', fg: '#2a2520', accent: 'hsl(18 65% 48%)' },
		{ id: 'moss', label: 'Moss', bg: '#191d1a', fg: '#e8ede6', accent: 'hsl(140 35% 58%)' },
		{ id: 'high-contrast', label: 'High Contrast', bg: '#000000', fg: '#ffffff', accent: 'hsl(45 100% 60%)' },
		{ id: 'system', label: 'Follow system', bg: 'linear-gradient(90deg,#1d1a19 50%,#faf6f0 50%)', fg: '#888', accent: 'hsl(18 70% 55%)' }
	];
	const swatches = [18, 0, 32, 45, 140, 170, 200, 230, 265, 290, 330];

	let theme = $state(data.settings.theme);
	let accentH = $state(data.settings.accentH);
	let readingPane = $state(data.settings.readingPane);

	// per-profile overrides
	let pTheme = $state(data.profile.theme ?? '');
	let pAccent = $state(data.profile.accent_h !== null ? String(data.profile.accent_h) : '');

	async function saveGlobal(settings: Record<string, string>) {
		try {
			await apiPost('/api/settings', { action: 'set', settings });
			await invalidateAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}

	async function saveProfileOverride() {
		try {
			await apiPost('/api/profiles', {
				action: 'update', profileId: data.profile.id,
				updates: { theme: pTheme || null, accent_h: pAccent === '' ? null : parseInt(pAccent, 10) }
			});
			await invalidateAll();
			toasts.success('Profile appearance updated');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}
</script>

<svelte:head><title>Settings · Appearance — Slate</title></svelte:head>

<h2>Appearance</h2>
<p class="s-sub">Themes apply instantly. Each profile can override the global look.</p>

<div class="s-section">
	<h3>Theme</h3>
	<div class="theme-grid">
		{#each themes as t (t.id)}
			<button class="theme-card" class:on={theme === t.id} onclick={() => { theme = t.id; void saveGlobal({ theme: t.id }); }} aria-pressed={theme === t.id}>
				<span class="theme-swatch" style="background: {t.bg}">
					<span class="ts-dot" style="background: {t.accent}"></span>
					<span class="ts-line" style="background: {t.fg}"></span>
				</span>
				{t.label}
			</button>
		{/each}
	</div>

	<h3>Accent color</h3>
	<div class="accent-row" role="group" aria-label="Accent color">
		{#each swatches as h (h)}
			<button
				class="accent-dot" class:on={accentH === h}
				style="background: hsl({h} 65% 55%)"
				onclick={() => { accentH = h; void saveGlobal({ accent_h: String(h) }); }}
				aria-label="Accent hue {h}"
			></button>
		{/each}
		<label class="custom-accent">
			<input type="range" min="0" max="359" bind:value={accentH} onchange={() => void saveGlobal({ accent_h: String(accentH) })} aria-label="Custom accent hue" />
			<span class="accent-dot preview" style="background: hsl({accentH} 65% 55%)"></span>
		</label>
	</div>

	<h3>Reading pane</h3>
	<div class="s-row">
		<div class="s-row-label">Position</div>
		<select class="input" bind:value={readingPane} onchange={() => void saveGlobal({ reading_pane: readingPane })}>
			<option value="right">Right</option>
			<option value="bottom">Bottom</option>
			<option value="off">Off (open full)</option>
		</select>
	</div>

	<h3>This profile ({data.profile.name})</h3>
	<div class="s-row">
		<div><div class="s-row-label">Theme override</div><div class="s-row-help">Leave empty to use the global theme</div></div>
		<select class="input" bind:value={pTheme} onchange={() => void saveProfileOverride()}>
			<option value="">Use global</option>
			{#each themes.filter((t) => t.id !== 'system') as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
		</select>
	</div>
	<div class="s-row">
		<div class="s-row-label">Accent override</div>
		<select class="input" bind:value={pAccent} onchange={() => void saveProfileOverride()}>
			<option value="">Use global</option>
			{#each swatches as h (h)}<option value={String(h)}>hue {h}</option>{/each}
		</select>
	</div>
</div>

<style>
	.theme-grid { display: flex; flex-wrap: wrap; gap: 10px; }
	.theme-card {
		display: flex; flex-direction: column; gap: 8px; align-items: center;
		background: var(--surface-1); border: 2px solid var(--border);
		border-radius: var(--r-2); padding: 10px;
		font-family: inherit; font-size: 12.5px; color: var(--text-2);
		cursor: pointer; width: 108px;
		transition: border-color var(--dur-1);
	}
	.theme-card.on { border-color: var(--accent); color: var(--text-1); font-weight: 600; }
	.theme-swatch {
		width: 84px; height: 54px; border-radius: var(--r-1);
		position: relative; overflow: hidden;
		border: 1px solid rgba(128,128,128,0.3);
	}
	.ts-dot { position: absolute; left: 8px; top: 8px; width: 12px; height: 12px; border-radius: 50%; }
	.ts-line { position: absolute; left: 8px; top: 28px; width: 50px; height: 5px; border-radius: 3px; opacity: 0.7; }
	.accent-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 0; }
	.accent-dot {
		width: 28px; height: 28px; border-radius: 50%;
		border: 2px solid transparent; cursor: pointer;
		transition: transform var(--dur-1);
	}
	.accent-dot:hover { transform: scale(1.15); }
	.accent-dot.on { border-color: var(--text-1); box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--text-1); }
	.custom-accent { display: flex; align-items: center; gap: 8px; margin-left: 8px; }
	.accent-dot.preview { cursor: default; }
</style>
