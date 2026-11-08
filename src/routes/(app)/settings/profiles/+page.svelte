<script lang="ts">
	import { apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	const icons = ['🏠', '💼', '🌿', '🎓', '🎨', '🚀', '📚', '🧩', '☕️', '🌙', '⚡️', '🫐'];
	const hues = [18, 0, 45, 140, 170, 200, 230, 265, 290, 330];

	let editing = $state<number | null>(null);
	let creating = $state(false);
	let name = $state('');
	let icon = $state('🏠');
	let accentH = $state(18);
	let confirmDelete = $state<number | null>(null);

	function startCreate() {
		creating = true; editing = null;
		name = ''; icon = '🏠'; accentH = 18;
	}
	function startEdit(p: (typeof data.profiles)[number]) {
		editing = p.id; creating = false;
		name = p.name; icon = p.icon; accentH = p.accent_h ?? 18;
	}

	async function save() {
		if (!name.trim()) { toasts.error('Name is required'); return; }
		try {
			if (creating) {
				await apiPost('/api/profiles', { action: 'create', name: name.trim(), icon, accentH });
			} else if (editing !== null) {
				await apiPost('/api/profiles', { action: 'update', profileId: editing, updates: { name: name.trim(), icon } });
			}
			creating = false; editing = null;
			await invalidateAll();
			toasts.success('Profile saved');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}

	async function remove(id: number) {
		try {
			await apiPost('/api/profiles', { action: 'delete', profileId: id });
			confirmDelete = null;
			await invalidateAll();
			toasts.success('Profile deleted');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not delete');
		}
	}

	async function move(id: number, dir: -1 | 1) {
		const order = data.profiles.map((p) => p.id);
		const i = order.indexOf(id);
		const j = i + dir;
		if (j < 0 || j >= order.length) return;
		[order[i], order[j]] = [order[j], order[i]];
		try {
			await apiPost('/api/profiles', { action: 'reorder', order });
			await invalidateAll();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not reorder');
		}
	}
</script>

<svelte:head><title>Settings · Profiles — Slate</title></svelte:head>

<h2>Profiles</h2>
<p class="s-sub">Fully isolated workspaces with their own accounts, settings, and appearance.</p>

<div class="s-section">
	{#each data.profiles as p, i (p.id)}
		<div class="p-row card">
			<span class="p-dot" style="background: hsl({p.accent_h ?? 18} 60% 50% / 0.2)">{p.icon}</span>
			<span class="p-name">{p.name}{#if p.id === data.profile.id}<span class="current"> · current</span>{/if}</span>
			<span class="p-actions">
				<button class="btn-ghost" onclick={() => void move(p.id, -1)} disabled={i === 0} aria-label="Move up">↑</button>
				<button class="btn-ghost" onclick={() => void move(p.id, 1)} disabled={i === data.profiles.length - 1} aria-label="Move down">↓</button>
				<button class="btn" onclick={() => startEdit(p)}>Edit</button>
				{#if confirmDelete === p.id}
					<button class="btn danger" onclick={() => void remove(p.id)}>Really delete?</button>
					<button class="btn-ghost" onclick={() => (confirmDelete = null)}>Cancel</button>
				{:else}
					<button class="btn-ghost" onclick={() => (confirmDelete = p.id)} disabled={data.profiles.length <= 1}>Delete</button>
				{/if}
			</span>
		</div>
	{/each}

	{#if creating || editing !== null}
		<div class="p-form card">
			<label>Name <input class="input" bind:value={name} placeholder="Work" /></label>
			<div class="pick">
				{#each icons as ic (ic)}
					<button class="icon-pick" class:on={icon === ic} onclick={() => (icon = ic)}>{ic}</button>
				{/each}
			</div>
			{#if creating}
				<div class="pick">
					{#each hues as h (h)}
						<button class="hue-pick" class:on={accentH === h} style="background: hsl({h} 65% 55%)" onclick={() => (accentH = h)} aria-label="Hue {h}"></button>
					{/each}
				</div>
			{/if}
			<div class="form-actions">
				<button class="btn btn-primary" onclick={() => void save()}>{creating ? 'Create profile' : 'Save'}</button>
				<button class="btn-ghost" onclick={() => { creating = false; editing = null; }}>Cancel</button>
			</div>
		</div>
	{:else}
		<button class="btn btn-primary add" onclick={startCreate}>＋ New profile</button>
	{/if}
</div>

<style>
	.p-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; margin-bottom: 8px; }
	.p-dot { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; font-size: 17px; flex: none; }
	.p-name { flex: 1; font-weight: 600; font-size: 14px; }
	.current { color: var(--accent); font-weight: 500; font-size: 12px; }
	.p-actions { display: flex; gap: 6px; align-items: center; }
	.danger { color: var(--danger); border-color: var(--danger); }
	.p-form { padding: 16px; display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
	.p-form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--text-2); }
	.pick { display: flex; flex-wrap: wrap; gap: 6px; }
	.icon-pick { font-size: 17px; width: 36px; height: 36px; border-radius: 10px; border: 2px solid transparent; background: var(--surface-2); cursor: pointer; }
	.icon-pick.on { border-color: var(--accent); }
	.hue-pick { width: 26px; height: 26px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
	.hue-pick.on { border-color: var(--text-1); }
	.form-actions { display: flex; gap: 8px; }
	.add { margin-top: 10px; }
</style>
