<script lang="ts">
	interface Props { open: boolean; onclose: () => void }
	let { open = $bindable(), onclose }: Props = $props();

	const sections: { title: string; rows: [string, string][] }[] = [
		{
			title: 'Global',
			rows: [
				['⌘/Ctrl K', 'Command palette'],
				['⌘/Ctrl .', 'Today side panel'],
				['⌘/Ctrl 1–9', 'Switch profile'],
				['?', 'This cheat sheet'],
				['/', 'Search'],
				['c', 'Compose'],
				['z', 'Undo'],
				['Esc', 'Close / back']
			]
		},
		{
			title: 'Go to',
			rows: [
				['g i', 'Inbox'],
				['g s', 'Sent'],
				['g d', 'Drafts'],
				['g t', 'Today'],
				['g c', 'Calendar']
			]
		},
		{
			title: 'Mail list',
			rows: [
				['j / k', 'Next / previous'],
				['o / Enter', 'Open'],
				['u', 'Back to list'],
				['x', 'Select'],
				['e', 'Archive'],
				['#', 'Delete'],
				['s', 'Star'],
				['b', 'Snooze'],
				['!', 'Mark spam'],
				['⇧I / ⇧U', 'Mark read / unread']
			]
		},
		{
			title: 'Message',
			rows: [
				['r', 'Reply'],
				['a', 'Reply all'],
				['f', 'Forward'],
				['t', 'Create task from email']
			]
		},
		{
			title: 'Tasks',
			rows: [
				['n', 'New task'],
				['Space', 'Toggle complete']
			]
		}
	];
</script>

{#if open}
	<div class="backdrop" onclick={() => { open = false; onclose(); }} onkeydown={(e) => { if (e.key === 'Escape') { open = false; onclose(); } }} role="presentation">
		<div class="sheet glass" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onclick={(e) => e.stopPropagation()}>
			<header>
				<h2>Keyboard shortcuts</h2>
				<button class="btn btn-ghost" onclick={() => { open = false; onclose(); }} aria-label="Close">✕</button>
			</header>
			<div class="grid">
				{#each sections as section (section.title)}
					<section>
						<h3>{section.title}</h3>
						{#each section.rows as [keys, label] (keys)}
							<div class="row">
								<span class="keys">
									{#each keys.split(' ') as k, i}
										{#if i > 0}<span class="then">then</span>{/if}
										<kbd class="kbd">{k}</kbd>
									{/each}
								</span>
								<span class="desc">{label}</span>
							</div>
						{/each}
					</section>
				{/each}
			</div>
			<footer>Shortcuts can be disabled in Settings → Shortcuts.</footer>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed; inset: 0; z-index: 900;
		background: color-mix(in oklab, var(--bg) 50%, transparent);
		backdrop-filter: blur(3px);
		display: grid; place-items: center; padding: 24px;
		animation: fade-in var(--dur-1) ease both;
	}
	.sheet {
		width: min(760px, 100%);
		max-height: min(80vh, 680px);
		border-radius: var(--r-4);
		box-shadow: var(--shadow-3);
		display: flex; flex-direction: column;
		animation: pal-in var(--dur-2) var(--ease-spring) both;
	}
	header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 18px 22px 10px;
	}
	h2 { font-family: var(--font-display); font-size: 19px; margin: 0; }
	.grid {
		overflow-y: auto;
		padding: 8px 22px 16px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
		gap: 10px 28px;
	}
	h3 {
		font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
		color: var(--text-3); margin: 12px 0 6px;
	}
	.row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
	.keys { display: inline-flex; align-items: center; gap: 4px; min-width: 86px; }
	.then { font-size: 10px; color: var(--text-3); }
	.desc { font-size: 13px; color: var(--text-2); }
	footer { padding: 10px 22px 16px; font-size: 12px; color: var(--text-3); }
	@keyframes fade-in { from { opacity: 0; } }
	@keyframes pal-in { from { opacity: 0; transform: translateY(-10px) scale(0.98); } }
	@media (prefers-reduced-motion: reduce) { .backdrop, .sheet { animation: none; } }
</style>
