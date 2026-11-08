<script lang="ts">
	import { goto } from '$app/navigation';
	import { fuzzyScore } from '$lib/client/fuzzy';
	import { apiGet } from '$lib/client/api';
	import { THEMES } from '$lib/config';

	export interface PaletteCommand {
		id: string;
		label: string;
		hint?: string; // keyboard hint
		group: string;
		icon?: string; // emoji or short glyph
		run: () => void | Promise<void>;
		keywords?: string;
	}

	interface Props {
		open: boolean;
		commands: PaletteCommand[];
		profileId: number;
		onclose: () => void;
	}

	let { open = $bindable(), commands, profileId, onclose }: Props = $props();

	let query = $state('');
	let selected = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let mailResults = $state<{ id: number; subject: string; from: { name: string; address: string }[]; folderId: number }[]>([]);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (open) {
			query = '';
			selected = 0;
			mailResults = [];
			requestAnimationFrame(() => inputEl?.focus());
		}
	});

	$effect(() => {
		const q = query;
		if (!open) return;
		if (searchTimer) clearTimeout(searchTimer);
		if (q.trim().length < 3) {
			mailResults = [];
			return;
		}
		searchTimer = setTimeout(async () => {
			try {
				const res = await apiGet<{ local: { id: number; subject: string; from: { name: string; address: string }[]; folderId: number }[] }>(
					`/api/search?profile=${profileId}&q=${encodeURIComponent(q)}`
				);
				mailResults = (res.local ?? []).slice(0, 5);
			} catch {
				mailResults = [];
			}
		}, 220);
	});

	const filtered = $derived.by(() => {
		const q = query.trim();
		const scored = commands
			.map((c) => ({ c, s: fuzzyScore(q, c.label + ' ' + (c.keywords ?? '')) }))
			.filter((x) => x.s >= 0)
			.sort((a, b) => b.s - a.s)
			.slice(0, q ? 12 : 16)
			.map((x) => x.c);
		return scored;
	});

	interface Row { kind: 'cmd' | 'mail'; cmd?: PaletteCommand; mail?: { id: number; subject: string; from: { name: string; address: string }[]; folderId: number } }
	const rows = $derived.by(() => {
		const out: Row[] = filtered.map((c) => ({ kind: 'cmd' as const, cmd: c }));
		for (const m of mailResults) out.push({ kind: 'mail', mail: m });
		return out;
	});

	const groups = $derived.by(() => {
		const seen = new Map<string, Row[]>();
		for (const r of rows) {
			const g = r.kind === 'mail' ? 'Mail results' : r.cmd!.group;
			if (!seen.has(g)) seen.set(g, []);
			seen.get(g)!.push(r);
		}
		return [...seen.entries()];
	});

	function flatIndex(row: Row): number {
		return rows.indexOf(row);
	}

	async function runRow(row: Row) {
		close();
		if (row.kind === 'cmd') await row.cmd!.run();
		else await goto(`/mail?message=${row.mail!.id}`);
	}

	function close() {
		open = false;
		onclose();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') { e.preventDefault(); close(); }
		else if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, rows.length - 1); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); }
		else if (e.key === 'Enter') {
			e.preventDefault();
			const row = rows[selected];
			if (row) void runRow(row);
		}
	}

	$effect(() => {
		void rows;
		if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
	});
</script>

{#if open}
	<div class="palette-backdrop" onclick={close} onkeydown={(e) => e.key === 'Escape' && close()} role="presentation">
		<div class="palette glass" role="dialog" aria-modal="true" aria-label="Command palette" onclick={(e) => e.stopPropagation()}>
			<div class="search-row">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
				<input
					bind:this={inputEl}
					bind:value={query}
					{onkeydown}
					type="text"
					placeholder="Search or run a command…"
					aria-label="Command palette search"
					autocomplete="off"
					spellcheck="false"
				/>
				<kbd class="kbd">esc</kbd>
			</div>
			<div class="results" role="listbox" aria-label="Commands">
				{#each groups as [groupName, groupRows] (groupName)}
					<div class="group-label">{groupName}</div>
					{#each groupRows as row (row.kind === 'cmd' ? row.cmd!.id : 'mail-' + row.mail!.id)}
						{@const idx = flatIndex(row)}
						<button
							class="row"
							class:sel={idx === selected}
							role="option"
							aria-selected={idx === selected}
							onclick={() => runRow(row)}
							onmousemove={() => (selected = idx)}
						>
							{#if row.kind === 'cmd'}
								<span class="icon" aria-hidden="true">{row.cmd!.icon ?? '›'}</span>
								<span class="label">{row.cmd!.label}</span>
								{#if row.cmd!.hint}<kbd class="kbd hint">{row.cmd!.hint}</kbd>{/if}
							{:else}
								<span class="icon" aria-hidden="true">✉️</span>
								<span class="label"><strong>{row.mail!.from[0]?.name || row.mail!.from[0]?.address || 'Unknown'}</strong> — {row.mail!.subject || '(no subject)'}</span>
							{/if}
						</button>
					{/each}
				{/each}
				{#if rows.length === 0}
					<div class="empty">Nothing matches "{query}"</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.palette-backdrop {
		position: fixed; inset: 0; z-index: 900;
		background: color-mix(in oklab, var(--bg) 45%, transparent);
		backdrop-filter: blur(3px);
		display: grid;
		place-items: start center;
		padding-top: clamp(60px, 16vh, 160px);
		animation: fade-in var(--dur-1) ease both;
	}
	.palette {
		width: min(620px, calc(100vw - 32px));
		border-radius: var(--r-4);
		box-shadow: var(--shadow-3);
		overflow: hidden;
		animation: pal-in var(--dur-2) var(--ease-spring) both;
	}
	.search-row {
		display: flex; align-items: center; gap: 10px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--border);
		color: var(--text-3);
	}
	.search-row input {
		flex: 1; background: none; border: none; outline: none;
		color: var(--text-1); font-size: 15px; font-family: inherit;
	}
	.search-row input::placeholder { color: var(--text-3); }
	.results { max-height: min(420px, 55vh); overflow-y: auto; padding: 6px; }
	.group-label {
		font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--text-3); padding: 10px 12px 4px;
	}
	.row {
		display: flex; align-items: center; gap: 10px;
		width: 100%; text-align: left;
		background: none; border: none; cursor: pointer;
		padding: 9px 12px; border-radius: var(--r-2);
		color: var(--text-1); font-size: 14px; font-family: inherit;
	}
	.row.sel { background: color-mix(in oklab, var(--accent) 14%, transparent); }
	.icon { width: 22px; text-align: center; flex: none; font-size: 14px; }
	.label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.hint { margin-left: auto; flex: none; }
	.empty { padding: 28px 16px; text-align: center; color: var(--text-3); font-size: 14px; }
	@keyframes fade-in { from { opacity: 0; } }
	@keyframes pal-in { from { opacity: 0; transform: translateY(-10px) scale(0.98); } }
	@media (prefers-reduced-motion: reduce) {
		.palette-backdrop, .palette { animation: none; }
	}
</style>
