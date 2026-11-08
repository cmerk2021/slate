<script lang="ts">
	import { apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	let undoSend = $state(String(data.settings.undoSendSeconds));
	let notifications = $state((data.profileSettings['notifications'] as boolean) ?? false);

	async function saveGlobal(settings: Record<string, string>) {
		try {
			await apiPost('/api/settings', { action: 'set', settings });
			await invalidateAll();
			toasts.success('Saved');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}

	async function toggleNotifications() {
		if (notifications && 'Notification' in window && Notification.permission !== 'granted') {
			const perm = await Notification.requestPermission();
			if (perm !== 'granted') {
				notifications = false;
				toasts.error('Browser notifications were not allowed');
				return;
			}
		}
		try {
			await apiPost('/api/settings', { action: 'set-profile', profileId: data.profile.id, settings: { notifications } });
			toasts.success(notifications ? 'Notifications on for this profile' : 'Notifications off');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}

	let untrustInput = $state('');
	async function untrust() {
		const s = untrustInput.trim().toLowerCase();
		if (!s) return;
		try {
			await apiPost('/api/mail', { action: 'untrust-sender', profileId: data.profile.id, sender: s });
			toasts.success(`Removed ${s} from trusted senders`);
			untrustInput = '';
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not remove');
		}
	}
</script>

<svelte:head><title>Settings · Mail — Slate</title></svelte:head>

<h2>Mail</h2>
<p class="s-sub">Sending, privacy, and notification behavior.</p>

<div class="s-section">
	<div class="s-row">
		<div><div class="s-row-label">Undo send delay</div><div class="s-row-help">Messages are held before actually sending</div></div>
		<select class="input" bind:value={undoSend} onchange={() => void saveGlobal({ undo_send_seconds: undoSend })}>
			<option value="0">Off (send immediately)</option>
			<option value="5">5 seconds</option>
			<option value="10">10 seconds</option>
			<option value="20">20 seconds</option>
			<option value="30">30 seconds</option>
		</select>
	</div>

	<div class="s-row">
		<div><div class="s-row-label">Remote images</div><div class="s-row-help">Blocked by default; loaded through the privacy proxy when allowed. Manage per-sender trust from the banner on each message.</div></div>
		<span class="pill">Blocked by default</span>
	</div>

	<div class="s-row">
		<div><div class="s-row-label">Remove a trusted sender</div><div class="s-row-help">Enter an address or @domain you previously trusted</div></div>
		<span class="inline-form">
			<input class="input" type="text" placeholder="name@example.com or @example.com" bind:value={untrustInput} />
			<button class="btn" onclick={() => void untrust()}>Remove</button>
		</span>
	</div>

	<div class="s-row">
		<div><div class="s-row-label">Split inbox rules</div><div class="s-row-help">Edit inbox tabs from the Mail view (⚙ next to the tabs)</div></div>
		<a class="btn" href="/mail">Open Mail</a>
	</div>

	<div class="s-row">
		<div><div class="s-row-label">Browser notifications ({data.profile.name})</div><div class="s-row-help">New mail, event reminders, and due tasks — per profile, opt-in</div></div>
		<input type="checkbox" bind:checked={notifications} onchange={() => void toggleNotifications()} aria-label="Enable notifications" />
	</div>
</div>

<style>
	.pill { font-size: 12px; color: var(--text-3); border: 1px solid var(--border); border-radius: 99px; padding: 3px 10px; }
	.inline-form { display: flex; gap: 6px; }
</style>
