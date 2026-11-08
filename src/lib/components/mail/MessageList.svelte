<script lang="ts">
	import { fmtListDate } from '$lib/client/format';

	export interface ListMessage {
		id: number;
		accountId: number;
		folderId: number;
		uid: number;
		subject: string;
		from: { name: string; address: string }[];
		date: number;
		seen: boolean;
		flagged: boolean;
		answered: boolean;
		draft: boolean;
		snippet: string;
		hasAttachments: boolean;
		threadKey: string | null;
		threadCount?: number;
		threadUnread?: number;
		snoozedUntil: number | null;
	}

	interface Props {
		messages: ListMessage[];
		selectedId: number | null;
		checkedIds: Set<number>;
		density: string;
		timeFormat: '12' | '24';
		onopen: (m: ListMessage) => void;
		oncheck: (m: ListMessage, shift: boolean) => void;
		onstar: (m: ListMessage) => void;
		onendreached: () => void;
	}

	let { messages, selectedId, checkedIds, density, timeFormat, onopen, oncheck, onstar, onendreached }: Props = $props();

	const rowH = $derived(density === 'compact' ? 56 : 72);
	let scrollEl = $state<HTMLDivElement | null>(null);
	let scrollTop = $state(0);
	let viewportH = $state(600);

	const overscan = 8;
	const startIdx = $derived(Math.max(0, Math.floor(scrollTop / rowH) - overscan));
	const endIdx = $derived(Math.min(messages.length, Math.ceil((scrollTop + viewportH) / rowH) + overscan));
	const visible = $derived(messages.slice(startIdx, endIdx));

	function onscroll() {
		if (!scrollEl) return;
		scrollTop = scrollEl.scrollTop;
		viewportH = scrollEl.clientHeight;
		if (scrollEl.scrollTop + scrollEl.clientHeight > scrollEl.scrollHeight - rowH * 20) {
			onendreached();
		}
	}

	export function scrollToIndex(i: number) {
		if (!scrollEl) return;
		const top = i * rowH;
		if (top < scrollEl.scrollTop) scrollEl.scrollTop = top;
		else if (top + rowH > scrollEl.scrollTop + scrollEl.clientHeight) scrollEl.scrollTop = top + rowH - scrollEl.clientHeight;
	}

	$effect(() => {
		if (scrollEl) viewportH = scrollEl.clientHeight;
	});
</script>

<div class="list" bind:this={scrollEl} {onscroll} role="listbox" aria-label="Messages" tabindex="-1">
	<div class="spacer" style="height: {messages.length * rowH}px">
		{#each visible as m, i (m.id)}
			{@const idx = startIdx + i}
			<div
				class="row"
				class:unseen={!m.seen}
				class:sel={m.id === selectedId}
				class:checked={checkedIds.has(m.id)}
				style="top: {idx * rowH}px; height: {rowH}px"
				role="option"
				aria-selected={m.id === selectedId}
				tabindex="-1"
				onclick={(e) => { if ((e.target as HTMLElement).closest('.check, .star')) return; onopen(m); }}
				onkeydown={(e) => { if (e.key === 'Enter') onopen(m); }}
			>
				<button
					class="check"
					aria-label={checkedIds.has(m.id) ? 'Deselect' : 'Select'}
					onclick={(e) => { e.stopPropagation(); oncheck(m, e.shiftKey); }}
				>
					<span class="checkbox" class:on={checkedIds.has(m.id)}>
						{#if checkedIds.has(m.id)}✓{/if}
					</span>
				</button>
				<div class="body">
					<div class="line1">
						<span class="from trunc">{m.from[0]?.name || m.from[0]?.address || 'Unknown'}</span>
						{#if (m.threadCount ?? 1) > 1}<span class="thread-count tnum">{m.threadCount}</span>{/if}
						{#if m.hasAttachments}<span class="att" title="Has attachments">📎</span>{/if}
						{#if m.snoozedUntil}<span class="att" title="Snoozed">⏰</span>{/if}
						<span class="date tnum">{fmtListDate(m.date, timeFormat)}</span>
					</div>
					<div class="line2">
						<span class="subj trunc">{m.subject || '(no subject)'}</span>
					</div>
					{#if density !== 'compact'}
						<div class="line3 trunc">{m.snippet}</div>
					{/if}
				</div>
				<button class="star" class:on={m.flagged} aria-label={m.flagged ? 'Unstar' : 'Star'} onclick={(e) => { e.stopPropagation(); onstar(m); }}>
					{m.flagged ? '★' : '☆'}
				</button>
			</div>
		{/each}
	</div>
	{#if messages.length === 0}
		<div class="empty-state">
			<span class="empty-glyph" aria-hidden="true">🍃</span>
			<p class="empty-title">All clear</p>
			<p class="empty-sub">Nothing here right now.</p>
		</div>
	{/if}
</div>

<style>
	.list { flex: 1; overflow-y: auto; position: relative; outline: none; }
	.spacer { position: relative; }
	.row {
		position: absolute; left: 0; right: 0;
		display: flex; align-items: center; gap: 2px;
		padding: 0 8px 0 2px;
		cursor: pointer;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 55%, transparent);
		transition: background var(--dur-1);
	}
	.row:hover { background: var(--surface-1); }
	.row.sel { background: color-mix(in oklab, var(--accent) 12%, transparent); }
	.row.checked { background: color-mix(in oklab, var(--accent) 18%, transparent); }
	.row:hover .check, .row.checked .check { opacity: 1; }
	.check {
		opacity: 0; transition: opacity var(--dur-1);
		background: none; border: none; cursor: pointer; padding: 6px;
	}
	.checkbox {
		display: grid; place-items: center;
		width: 16px; height: 16px;
		border: 1.5px solid var(--text-3); border-radius: 5px;
		font-size: 11px; color: var(--accent-contrast);
	}
	.checkbox.on { background: var(--accent); border-color: var(--accent); }
	.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
	.line1 { display: flex; align-items: center; gap: 6px; }
	.from { font-size: 13.5px; font-weight: 480; color: var(--text-2); flex: 1; }
	.row.unseen .from { font-weight: 680; color: var(--text-1); }
	.thread-count {
		font-size: 11px; color: var(--text-3);
		border: 1px solid var(--border); border-radius: 99px; padding: 0 5px;
	}
	.att { font-size: 11px; }
	.date { font-size: 11.5px; color: var(--text-3); flex: none; }
	.row.unseen .date { color: var(--accent); font-weight: 600; }
	.line2 { display: flex; }
	.subj { font-size: 13px; color: var(--text-2); }
	.row.unseen .subj { color: var(--text-1); font-weight: 560; }
	.line3 { font-size: 12px; color: var(--text-3); }
	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.star {
		background: none; border: none; cursor: pointer;
		font-size: 15px; color: var(--text-3); padding: 6px;
		opacity: 0; transition: opacity var(--dur-1), color var(--dur-1);
	}
	.row:hover .star, .star.on { opacity: 1; }
	.star.on { color: var(--warn); }
	.empty-state {
		position: absolute; inset: 0;
		display: grid; place-content: center; text-align: center; gap: 2px;
		color: var(--text-3);
	}
	.empty-glyph { font-size: 34px; margin-bottom: 8px; }
	.empty-title { font-family: var(--font-display); font-size: 17px; color: var(--text-2); margin: 0; }
	.empty-sub { font-size: 13px; margin: 0; }
</style>
