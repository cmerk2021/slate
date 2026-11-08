<script lang="ts">
	import { toasts } from '$lib/client/toasts.svelte';
</script>

<div class="toast-region" role="region" aria-live="polite" aria-label="Notifications">
	{#each toasts.toasts as t (t.id)}
		<div class="toast glass kind-{t.kind}">
			{#if t.kind === 'success'}<span class="dot ok" aria-hidden="true"></span>
			{:else if t.kind === 'error'}<span class="dot bad" aria-hidden="true"></span>
			{:else if t.kind === 'progress'}<span class="spinner" aria-hidden="true"></span>
			{/if}
			<span class="msg">{t.message}</span>
			{#if t.kind === 'undo'}
				<button class="undo-btn" onclick={() => toasts.undo(t.id)}>
					{t.undoLabel}
					<span class="kbd-hint">Z</span>
				</button>
				<span class="timer" style="--dur: {t.duration}ms" aria-hidden="true"></span>
			{/if}
			<button class="close" onclick={() => toasts.dismiss(t.id)} aria-label="Dismiss">×</button>
		</div>
	{/each}
</div>

<style>
	.toast-region {
		position: fixed;
		bottom: 20px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		z-index: 1000;
		pointer-events: none;
	}
	.toast {
		pointer-events: auto;
		position: relative;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-radius: var(--r-3);
		box-shadow: var(--shadow-3);
		font-size: 13.5px;
		max-width: min(480px, calc(100vw - 32px));
		overflow: hidden;
		animation: toast-in var(--dur-2) var(--ease-spring) both;
	}
	.msg { flex: 1; min-width: 0; }
	.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
	.dot.ok { background: var(--success); }
	.dot.bad { background: var(--danger); }
	.spinner {
		width: 14px; height: 14px; flex: none;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.undo-btn {
		display: inline-flex; align-items: center; gap: 6px;
		background: color-mix(in oklab, var(--accent) 16%, transparent);
		color: var(--accent);
		border: none; border-radius: var(--r-1);
		padding: 4px 10px; font-size: 13px; font-weight: 600; cursor: pointer;
		transition: background var(--dur-1);
	}
	.undo-btn:hover { background: color-mix(in oklab, var(--accent) 26%, transparent); }
	.kbd-hint {
		font-size: 10px; opacity: 0.7; border: 1px solid currentColor;
		border-radius: 4px; padding: 0 4px; line-height: 1.4;
	}
	.close {
		background: none; border: none; color: var(--text-3); cursor: pointer;
		font-size: 16px; padding: 0 2px; line-height: 1;
	}
	.close:hover { color: var(--text-1); }
	.timer {
		position: absolute; bottom: 0; left: 0; height: 2px;
		background: var(--accent);
		animation: shrink var(--dur) linear forwards;
	}
	@keyframes toast-in { from { opacity: 0; transform: translateY(12px) scale(0.96); } }
	@keyframes shrink { from { width: 100%; } to { width: 0%; } }
	@keyframes spin { to { transform: rotate(360deg); } }
	@media (prefers-reduced-motion: reduce) {
		.toast { animation: none; }
		.timer { animation-duration: 0.01ms; animation-delay: var(--dur); }
	}
</style>
