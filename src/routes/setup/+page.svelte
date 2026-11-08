<script lang="ts">
	import { enhance } from '$app/forms';
	import { APP_NAME, PROFILE_ICONS } from '$lib/config';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let password = $state('');
	let confirm = $state('');
	let profileName = $state('Personal');
	let profileIcon = $state('🏠');
	let submitting = $state(false);
	let step = $state(1);

	const strength = $derived.by(() => {
		let score = 0;
		if (password.length >= 12) score++;
		if (password.length >= 16) score++;
		if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
		if (/\d/.test(password)) score++;
		if (/[^a-zA-Z0-9]/.test(password)) score++;
		return score;
	});
	const strengthLabel = $derived(['Too short', 'Weak', 'Okay', 'Good', 'Strong', 'Excellent'][strength]);
	const canContinue = $derived(password.length >= 12 && password === confirm);
</script>

<svelte:head><title>Welcome · {APP_NAME}</title></svelte:head>

<div class="auth-wrap">
	<div class="auth-card card">
		<div class="brand">
			<div class="brand-mark" aria-hidden="true">S</div>
			<h1>Welcome to {APP_NAME}</h1>
			<p class="sub">Your calm home for mail, calendar, contacts, and tasks. Let's set things up — it takes a minute.</p>
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
			<div class="steps" class:step2={step === 2}>
				<section class="step-panel" aria-hidden={step !== 1}>
					<label class="field">
						<span>App password</span>
						<input
							class="input"
							type="password"
							name="password"
							bind:value={password}
							minlength="12"
							required
							autocomplete="new-password"
							placeholder="At least 12 characters"
							readonly={step !== 1}
							tabindex={step === 1 ? 0 : -1}
						/>
					</label>
					<div class="meter" role="status" aria-label="Password strength: {strengthLabel}">
						<div class="meter-track">
							{#each Array(5) as _, i}
								<div class="meter-seg" class:on={i < strength} style="--seg-i: {i}"></div>
							{/each}
						</div>
						<span class="meter-label" class:good={strength >= 3}>{password ? strengthLabel : ''}</span>
					</div>
					<label class="field">
						<span>Confirm password</span>
						<input class="input" type="password" name="confirm" bind:value={confirm} required autocomplete="new-password" readonly={step !== 1} tabindex={step === 1 ? 0 : -1} />
						{#if confirm && confirm !== password}
							<small class="err">Passwords don't match yet.</small>
						{/if}
					</label>
					<button type="button" class="btn btn-primary wide" disabled={!canContinue} onclick={() => (step = 2)}>Continue</button>
				</section>

				<section class="step-panel" aria-hidden={step !== 2}>
					<label class="field">
						<span>Name your first profile</span>
						<input class="input" type="text" name="profileName" bind:value={profileName} maxlength="40" placeholder="Personal" disabled={step !== 2} />
					</label>
					<fieldset class="field">
						<legend>Pick an icon</legend>
						<div class="icon-grid">
							{#each PROFILE_ICONS as icon}
								<button type="button" class="icon-btn" class:sel={profileIcon === icon} onclick={() => (profileIcon = icon)} aria-pressed={profileIcon === icon} disabled={step !== 2}>
									{icon}
								</button>
							{/each}
						</div>
						<input type="hidden" name="profileIcon" value={profileIcon} />
					</fieldset>
					{#if form?.error}
						<p class="err" role="alert">{form.error}</p>
					{/if}
					<div class="row">
						<button type="button" class="btn" onclick={() => (step = 1)} disabled={step !== 2}>Back</button>
						<button type="submit" class="btn btn-primary grow" disabled={submitting || step !== 2}>
							{submitting ? 'Setting up…' : 'Create & get started'}
						</button>
					</div>
				</section>
			</div>
		</form>
	</div>
	<p class="foot">Self-hosted · single user · your data stays yours</p>
</div>

<style>
	.auth-wrap {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		align-content: center;
		gap: 20px;
		padding: 24px;
		background:
			radial-gradient(1200px 600px at 20% -10%, color-mix(in oklab, var(--accent) 9%, transparent), transparent 60%),
			radial-gradient(900px 500px at 110% 110%, color-mix(in oklab, var(--accent) 7%, transparent), transparent 60%),
			var(--bg);
	}
	.auth-card {
		width: min(430px, 100%);
		padding: 36px 34px 30px;
		animation: rise var(--dur-2) var(--ease-spring) both;
	}
	.brand { text-align: center; margin-bottom: 26px; }
	.brand-mark {
		width: 56px; height: 56px;
		margin: 0 auto 14px;
		display: grid; place-items: center;
		border-radius: 18px;
		background: linear-gradient(135deg, var(--accent), color-mix(in oklab, var(--accent) 60%, var(--bg)));
		color: var(--accent-contrast);
		font-family: var(--font-display);
		font-size: 28px; font-weight: 700;
		box-shadow: var(--shadow-2);
	}
	h1 { font-family: var(--font-display); font-size: 26px; margin: 0 0 8px; letter-spacing: -0.01em; }
	.sub { color: var(--text-2); font-size: 14px; margin: 0; line-height: 1.5; }
	.steps { display: grid; grid-template-columns: 100% 100%; overflow: hidden; transition: none; }
	.step-panel { grid-row: 1; transition: transform var(--dur-2) var(--ease-spring), opacity var(--dur-2) ease; min-width: 0; }
	.step-panel:first-child { grid-column: 1; }
	.step-panel:last-child { grid-column: 2; }
	.steps .step-panel { transform: translateX(0); }
	.steps.step2 .step-panel { transform: translateX(-100%); }
	.step-panel[aria-hidden='true'] { opacity: 0; pointer-events: none; }
	.field { display: block; margin-bottom: 16px; border: 0; padding: 0; }
	.field > span, .field > legend { display: block; font-size: 13px; font-weight: 550; color: var(--text-2); margin-bottom: 6px; }
	.meter { display: flex; align-items: center; gap: 10px; margin: -8px 0 16px; min-height: 18px; }
	.meter-track { display: flex; gap: 4px; flex: 1; }
	.meter-seg {
		height: 4px; flex: 1; border-radius: 99px;
		background: var(--surface-3);
		transition: background var(--dur-1) ease;
		transition-delay: calc(var(--seg-i) * 30ms);
	}
	.meter-seg.on { background: var(--accent); }
	.meter-label { font-size: 12px; color: var(--text-3); min-width: 64px; text-align: right; }
	.meter-label.good { color: var(--accent); }
	.icon-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
	.icon-btn {
		aspect-ratio: 1; border-radius: var(--r-2); border: 1px solid var(--border);
		background: var(--surface-1); font-size: 20px; cursor: pointer;
		transition: transform var(--dur-1) var(--ease-spring), border-color var(--dur-1), background var(--dur-1);
	}
	.icon-btn:hover { transform: scale(1.08); }
	.icon-btn.sel { border-color: var(--accent); background: color-mix(in oklab, var(--accent) 14%, var(--surface-1)); }
	.wide { width: 100%; }
	.row { display: flex; gap: 10px; }
	.grow { flex: 1; }
	.err { color: var(--danger); font-size: 13px; margin: 4px 0 10px; }
	.foot { color: var(--text-3); font-size: 12.5px; }
	@keyframes rise { from { opacity: 0; transform: translateY(14px) scale(0.985); } }
	@media (prefers-reduced-motion: reduce) {
		.auth-card { animation: none; }
		.step-panel { transition: none; }
	}
</style>
