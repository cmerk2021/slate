<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		if ('serviceWorker' in navigator && location.protocol === 'https:') {
			navigator.serviceWorker.register('/sw.js').catch(() => {});
		}
	});
</script>

{@render children()}
