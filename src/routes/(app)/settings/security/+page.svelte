<script lang="ts">
	import { onMount } from 'svelte';
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { startRegistration } from '@simplewebauthn/browser';

	interface SessionRow { id: string; created_at: number; last_seen: number; user_agent: string; ip: string }
	interface PasskeyRow { id: string; name: string; created_at: number; last_used: number | null }

	let sessions = $state<SessionRow[]>([]);
	let currentSession = $state('');
	let passkeys = $state<PasskeyRow[]>([]);
	let passkeySupported = $state(true);

	let curPw = $state('');
	let newPw = $state('');
	let newPw2 = $state('');
	let changing = $state(false);

	let renameId = $state<string | null>(null);
	let renameVal = $state('');

	async function load() {
		const [s, p] = await Promise.all([
			apiGet<{ sessions: SessionRow[]; current: string }>('/api/settings?view=sessions'),
			apiGet<{ passkeys: PasskeyRow[] }>('/api/settings?view=passkeys')
		]);
		sessions = s.sessions; currentSession = s.current; passkeys = p.passkeys;
	}
	onMount(() => {
		void load();
		passkeySupported = !!window.PublicKeyCredential && (window.isSecureContext ?? (location.protocol === 'https:' || location.hostname === 'localhost'));
	});

	function strength(pw: string): number {
		let s = 0;
		if (pw.length >= 12) s++;
		if (pw.length >= 16) s++;
		if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
		if (/\d/.test(pw)) s++;
		if (/[^a-zA-Z0-9]/.test(pw)) s++;
		return Math.min(s, 4);
	}
	const pwStrength = $derived(strength(newPw));

	async function changePassword() {
		if (newPw.length < 12) { toasts.error('New password must be at least 12 characters'); return; }
		if (newPw !== newPw2) { toasts.error('Passwords do not match'); return; }
		changing = true;
		try {
			const res = await apiPost<{ ok: boolean; error?: string }>('/api/settings', { action: 'change-password', currentPassword: curPw, newPassword: newPw });
			if (!res.ok) throw new Error(res.error ?? 'Failed');
			curPw = newPw = newPw2 = '';
			toasts.success('Password changed');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not change password');
		} finally {
			changing = false;
		}
	}

	async function addPasskey() {
		const name = prompt('Name this passkey (e.g. "MacBook Touch ID")', 'Passkey');
		if (name === null) return;
		try {
			const { options, challengeId } = await apiGet<{ options: Parameters<typeof startRegistration>[0]['optionsJSON']; challengeId: string }>('/api/auth/passkey/register');
			const response = await startRegistration({ optionsJSON: options });
			const res = await apiPost<{ ok: boolean; error?: string }>('/api/auth/passkey/register', { challengeId, response, name });
			if (!res.ok) throw new Error(res.error ?? 'Registration failed');
			toasts.success('Passkey registered');
			await load();
		} catch (e) {
			if (e instanceof Error && e.name === 'NotAllowedError') return;
			toasts.error(e instanceof Error ? e.message : 'Passkey registration failed');
		}
	}

	async function saveRename() {
		if (!renameId) return;
		try {
			await apiPost('/api/settings', { action: 'rename-passkey', passkeyId: renameId, name: renameVal });
			renameId = null;
			await load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not rename');
		}
	}

	async function deleteKey(id: string) {
		if (!confirm('Revoke this passkey? You can no longer sign in with it.')) return;
		try {
			await apiPost('/api/settings', { action: 'delete-passkey', passkeyId: id });
			await load();
			toasts.success('Passkey revoked');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not revoke');
		}
	}

	async function revokeSession(id: string) {
		try {
			await apiPost('/api/settings', { action: 'revoke-session', sessionId: id });
			await load();
			toasts.success('Session revoked');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not revoke');
		}
	}

	function fmtDate(ms: number) {
		return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}
	function uaShort(ua: string) {
		if (/firefox/i.test(ua)) return 'Firefox';
		if (/edg/i.test(ua)) return 'Edge';
		if (/chrome/i.test(ua)) return 'Chrome';
		if (/safari/i.test(ua)) return 'Safari';
		return ua.slice(0, 40) || 'Unknown browser';
	}
</script>

<svelte:head><title>Settings · Security — Slate</title></svelte:head>

<h2>Security</h2>
<p class="s-sub">Password, passkeys, and active sessions.</p>

<div class="s-section">
	<h3>Change password</h3>
	<div class="pw-form">
		<input class="input" type="password" placeholder="Current password" bind:value={curPw} autocomplete="current-password" />
		<input class="input" type="password" placeholder="New password (min 12 characters)" bind:value={newPw} autocomplete="new-password" />
		{#if newPw}
			<div class="meter" role="img" aria-label="Password strength {pwStrength} of 4">
				{#each [0, 1, 2, 3] as i (i)}<span class="seg" class:on={pwStrength > i} data-level={pwStrength}></span>{/each}
			</div>
		{/if}
		<input class="input" type="password" placeholder="Repeat new password" bind:value={newPw2} autocomplete="new-password" />
		<button class="btn btn-primary" onclick={() => void changePassword()} disabled={changing || !curPw || !newPw}>
			{changing ? 'Changing…' : 'Change password'}
		</button>
	</div>

	<h3>Passkeys</h3>
	{#if !passkeySupported}
		<p class="warn">⚠️ Passkeys need a secure origin (https, or localhost). Check that APP_ORIGIN and RP_ID match the URL you are using.</p>
	{/if}
	{#each passkeys as pk (pk.id)}
		<div class="s-row">
			{#if renameId === pk.id}
				<input class="input" bind:value={renameVal} onkeydown={(e) => e.key === 'Enter' && void saveRename()} />
				<span class="row-btns">
					<button class="btn" onclick={() => void saveRename()}>Save</button>
					<button class="btn-ghost" onclick={() => (renameId = null)}>Cancel</button>
				</span>
			{:else}
				<div>
					<div class="s-row-label">🔑 {pk.name}</div>
					<div class="s-row-help">Added {fmtDate(pk.created_at)}{pk.last_used ? ` · last used ${fmtDate(pk.last_used)}` : ''}</div>
				</div>
				<span class="row-btns">
					<button class="btn-ghost" onclick={() => { renameId = pk.id; renameVal = pk.name; }}>Rename</button>
					<button class="btn-ghost danger" onclick={() => void deleteKey(pk.id)}>Revoke</button>
				</span>
			{/if}
		</div>
	{/each}
	<button class="btn add" onclick={() => void addPasskey()} disabled={!passkeySupported}>＋ Register a passkey</button>

	<h3>Active sessions</h3>
	{#each sessions as s (s.id)}
		<div class="s-row">
			<div>
				<div class="s-row-label">{uaShort(s.user_agent)}{#if s.id === currentSession}<span class="this"> · this device</span>{/if}</div>
				<div class="s-row-help">{s.ip} · last active {fmtDate(s.last_seen)}</div>
			</div>
			{#if s.id !== currentSession}
				<button class="btn-ghost danger" onclick={() => void revokeSession(s.id)}>Revoke</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	.pw-form { display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
	.meter { display: flex; gap: 4px; }
	.seg { flex: 1; height: 4px; border-radius: 2px; background: var(--surface-3); }
	.seg.on[data-level='1'] { background: var(--danger); }
	.seg.on[data-level='2'] { background: var(--warn); }
	.seg.on[data-level='3'], .seg.on[data-level='4'] { background: var(--success); }
	.warn { font-size: 13px; color: var(--warn); background: color-mix(in oklab, var(--warn) 10%, transparent); border-radius: var(--r-2); padding: 10px 12px; }
	.row-btns { display: flex; gap: 6px; }
	.danger { color: var(--danger); }
	.this { color: var(--accent); font-size: 12px; }
	.add { margin-top: 10px; }
</style>
