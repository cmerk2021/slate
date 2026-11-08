<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { APP_NAME } from '$lib/config';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let submitting = $state(false);
	let passkeyError = $state('');
	let passkeyBusy = $state(false);

	async function passkeyLogin(conditional = false) {
		passkeyError = '';
		passkeyBusy = !conditional;
		try {
			const { startAuthentication } = await import('@simplewebauthn/browser');
			const optRes = await fetch('/api/auth/passkey/login');
			if (!optRes.ok) throw new Error('Could not start passkey sign-in');
			const { options, challengeId } = await optRes.json();
			const assertion = await startAuthentication({ optionsJSON: options, useBrowserAutofill: conditional });
			const verifyRes = await fetch('/api/auth/passkey/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ challengeId, response: assertion })
			});
			const result = await verifyRes.json();
			if (result.ok) {
				location.href = '/today';
			} else {
				passkeyError = result.error ?? 'Passkey sign-in failed.';
			}
		} catch (e) {
			if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
				// user cancelled — stay quiet
			} else {
				passkeyError = e instanceof Error ? e.message : 'Passkey sign-in failed.';
			}
		} finally {
			passkeyBusy = false;
		}
	}

	onMount(async () => {
		if (!data.hasPasskeys || !data.passkeysAvailable) return;
		try {
			const { browserSupportsWebAuthnAutofill } = await import('@simplewebauthn/browser');
			if (await browserSupportsWebAuthnAutofill()) void passkeyLogin(true);
		} catch {
			/* conditional UI unsupported */
		}
	});
</script>

<svelte:head><title>Sign in · {APP_NAME}</title></svelte:head>

<div class="auth-wrap">
	<div class="auth-card card">
		<div class="brand">
			<div class="brand-mark" aria-hidden="true">S</div>
			<h1>{APP_NAME}</h1>
			<p class="sub">Welcome back.</p>
		</div>

		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}
		>
			<label class="field">
				<span>Password</span>
				<input
					class="input"
					type="password"
					name="password"
					required
					autocomplete="current-password webauthn"
					placeholder="Your app password"
				/>
			</label>
			{#if form?.error}
				<p class="err" role="alert">{form.error}</p>
			{/if}
			<button type="submit" class="btn btn-primary wide" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign in'}
			</button>
		</form>

		{#if data.hasPasskeys}
			{#if data.passkeysAvailable}
				<div class="divider"><span>or</span></div>
				<button type="button" class="btn wide passkey-btn" onclick={() => passkeyLogin(false)} disabled={passkeyBusy}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>
					Sign in with passkey
				</button>
				{#if passkeyError}
					<p class="err" role="alert">{passkeyError}</p>
				{/if}
			{:else}
				<p class="notice">Passkeys are unavailable: this app is not served over HTTPS (or RP_ID doesn't match the hostname). Set <code>APP_ORIGIN</code> and <code>RP_ID</code> and serve over HTTPS to use passkeys.</p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.auth-wrap {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 24px;
		background:
			radial-gradient(1200px 600px at 20% -10%, color-mix(in oklab, var(--accent) 9%, transparent), transparent 60%),
			radial-gradient(900px 500px at 110% 110%, color-mix(in oklab, var(--accent) 7%, transparent), transparent 60%),
			var(--bg);
	}
	.auth-card {
		width: min(380px, 100%);
		padding: 36px 34px 30px;
		animation: rise var(--dur-2) var(--ease-spring) both;
	}
	.brand { text-align: center; margin-bottom: 24px; }
	.brand-mark {
		width: 56px; height: 56px; margin: 0 auto 14px;
		display: grid; place-items: center;
		border-radius: 18px;
		background: linear-gradient(135deg, var(--accent), color-mix(in oklab, var(--accent) 60%, var(--bg)));
		color: var(--accent-contrast);
		font-family: var(--font-display); font-size: 28px; font-weight: 700;
		box-shadow: var(--shadow-2);
	}
	h1 { font-family: var(--font-display); font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
	.sub { color: var(--text-2); font-size: 14px; margin: 0; }
	.field { display: block; margin-bottom: 16px; }
	.field > span { display: block; font-size: 13px; font-weight: 550; color: var(--text-2); margin-bottom: 6px; }
	.wide { width: 100%; }
	.passkey-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
	.divider {
		display: flex; align-items: center; gap: 12px;
		margin: 18px 0; color: var(--text-3); font-size: 12px;
	}
	.divider::before, .divider::after { content: ''; height: 1px; flex: 1; background: var(--border); }
	.err { color: var(--danger); font-size: 13px; margin: 8px 0; }
	.notice {
		margin-top: 16px; font-size: 12.5px; line-height: 1.5; color: var(--text-3);
		background: var(--surface-2); border: 1px solid var(--border);
		border-radius: var(--r-2); padding: 10px 12px;
	}
	.notice code { font-size: 11.5px; }
	@keyframes rise { from { opacity: 0; transform: translateY(14px) scale(0.985); } }
	@media (prefers-reduced-motion: reduce) { .auth-card { animation: none; } }
</style>
