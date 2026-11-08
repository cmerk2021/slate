<script lang="ts">
	import { APP_NAME } from '$lib/config';
</script>

<svelte:head><title>Offline · {APP_NAME}</title></svelte:head>

<div class="offline-wrap">
	<div class="card inner">
		<div class="glyph" aria-hidden="true">⌁</div>
		<h1>You're offline</h1>
		<p>{APP_NAME} can't reach the server right now. Check your connection and try again.</p>
		<button class="btn btn-primary" onclick={() => location.reload()}>Retry</button>
	</div>
</div>

<style>
	.offline-wrap { min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--bg); }
	.inner { width: min(360px, 100%); padding: 40px 32px; text-align: center; }
	.glyph { font-size: 40px; margin-bottom: 12px; color: var(--text-3); }
	h1 { font-family: var(--font-display); font-size: 22px; margin: 0 0 8px; }
	p { color: var(--text-2); font-size: 14px; margin: 0 0 20px; line-height: 1.5; }
</style>
