<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { invalidateAll } from '$app/navigation';

	let { data } = $props();

	interface AccountRow {
		id: number; kind: string; name: string; email: string;
		imap_host: string | null; imap_port: number | null; imap_security: string | null;
		smtp_host: string | null; smtp_port: number | null; smtp_security: string | null;
		dav_url: string | null; username: string; allow_self_signed: number;
	}
	interface IdentityRow { id: number; account_id: number; email: string; name: string; signature_html: string; is_default: number }
	interface Preset {
		id: string; name: string;
		imapHost: string; imapPort: number; imapSecurity: string;
		smtpHost: string; smtpPort: number; smtpSecurity: string;
		caldavUrl?: string; carddavUrl?: string; note?: string;
	}

	let accounts = $state<AccountRow[]>([]);
	let identities = $state<IdentityRow[]>([]);
	let presets = $state<Preset[]>([]);

	async function load() {
		const res = await apiGet<{ accounts: AccountRow[]; identities: IdentityRow[]; presets: Preset[] }>(`/api/accounts?profile=${data.profile.id}`);
		accounts = res.accounts; identities = res.identities; presets = res.presets;
	}
	$effect(() => { void data.profile.id; void load(); });

	// ---------- wizard ----------
	type Kind = 'imap' | 'pop3' | 'caldav' | 'carddav';
	let wizardOpen = $state(false);
	let kind = $state<Kind>('imap');
	let presetId = $state('');
	let presetNote = $state('');
	let name = $state('');
	let email = $state('');
	let username = $state('');
	let password = $state('');
	let imapHost = $state(''); let imapPort = $state(993); let imapSecurity = $state('tls');
	let smtpHost = $state(''); let smtpPort = $state(465); let smtpSecurity = $state('tls');
	let davUrl = $state('');
	let allowSelfSigned = $state(false);
	let discovering = $state(false);
	let testing = $state(false);
	let saving = $state(false);
	let testResult = $state<{ ok: boolean; results: Record<string, { ok: boolean; error?: string }> } | null>(null);
	let overrideSave = $state(false);

	function openWizard(k: Kind) {
		wizardOpen = true; kind = k;
		presetId = ''; presetNote = ''; name = ''; email = ''; username = ''; password = '';
		imapHost = ''; imapPort = k === 'pop3' ? 995 : 993; imapSecurity = 'tls';
		smtpHost = ''; smtpPort = 465; smtpSecurity = 'tls';
		davUrl = ''; allowSelfSigned = false; testResult = null; overrideSave = false;
	}

	function applyPreset(id: string) {
		const p = presets.find((x) => x.id === id);
		presetNote = p?.note ?? '';
		if (!p) return;
		if (kind === 'imap' || kind === 'pop3') {
			imapHost = p.imapHost; imapPort = p.imapPort; imapSecurity = p.imapSecurity;
			smtpHost = p.smtpHost; smtpPort = p.smtpPort; smtpSecurity = p.smtpSecurity;
		} else if (kind === 'caldav' && p.caldavUrl) davUrl = p.caldavUrl;
		else if (kind === 'carddav' && p.carddavUrl) davUrl = p.carddavUrl;
	}

	async function discover() {
		if (!email.includes('@')) return;
		discovering = true;
		try {
			const res = await apiPost<{ found: Partial<Preset> | null }>('/api/accounts', { action: 'autodiscover', email });
			if (res.found) {
				const f = res.found;
				if (kind === 'imap' || kind === 'pop3') {
					if (f.imapHost) { imapHost = f.imapHost; imapPort = f.imapPort ?? 993; imapSecurity = f.imapSecurity ?? 'tls'; }
					if (f.smtpHost) { smtpHost = f.smtpHost; smtpPort = f.smtpPort ?? 465; smtpSecurity = f.smtpSecurity ?? 'tls'; }
				} else if (kind === 'caldav' && f.caldavUrl) davUrl = f.caldavUrl;
				else if (kind === 'carddav' && f.carddavUrl) davUrl = f.carddavUrl;
				if (f.note) presetNote = f.note;
				toasts.success('Server settings discovered');
			} else {
				toasts.show('No autoconfig found — enter server details manually', 'info');
			}
			if (!username) username = email;
		} catch { /* manual entry */ } finally {
			discovering = false;
		}
	}

	async function test() {
		testing = true; testResult = null;
		try {
			testResult = await apiPost<{ ok: boolean; results: Record<string, { ok: boolean; error?: string }> }>('/api/accounts', {
				action: 'test', kind,
				imapHost, imapPort, imapSecurity, smtpHost, smtpPort, smtpSecurity,
				davUrl, username: username || email, password, allowSelfSigned
			});
		} catch (e) {
			testResult = { ok: false, results: { error: { ok: false, error: e instanceof Error ? e.message : 'Test failed' } } };
		} finally {
			testing = false;
		}
	}

	async function save() {
		if (!testResult?.ok && !overrideSave) {
			toasts.error('Run “Test connection” first, or tick the override to save anyway');
			return;
		}
		saving = true;
		try {
			const res = await apiPost<{ ok: boolean; accountId?: number; error?: string }>('/api/accounts', {
				action: 'create', profileId: data.profile.id, kind,
				name: name || (kind === 'imap' || kind === 'pop3' ? email : davUrl),
				email: email || username,
				imapHost, imapPort: Number(imapPort), imapSecurity,
				smtpHost, smtpPort: Number(smtpPort), smtpSecurity,
				davUrl, username: username || email, password, allowSelfSigned
			});
			if (!res.ok) throw new Error(res.error ?? 'Failed');
			wizardOpen = false;
			await Promise.all([load(), invalidateAll()]);
			toasts.success('Account connected — syncing now');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save account');
		} finally {
			saving = false;
		}
	}

	// ---------- existing accounts ----------
	let pwAccount = $state<number | null>(null);
	let pwValue = $state('');
	async function updatePw() {
		if (pwAccount === null) return;
		try {
			await apiPost('/api/accounts', { action: 'update-password', accountId: pwAccount, password: pwValue });
			pwAccount = null; pwValue = '';
			toasts.success('Password updated');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not update');
		}
	}

	async function removeAccount(id: number) {
		if (!confirm('Remove this account and its cached data from this profile?')) return;
		try {
			await apiPost('/api/accounts', { action: 'delete', accountId: id });
			await Promise.all([load(), invalidateAll()]);
			toasts.success('Account removed');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not remove');
		}
	}

	// ---------- identities ----------
	let identEditing = $state<number | 'new' | null>(null);
	let identAccount = $state<number>(0);
	let identEmail = $state('');
	let identName = $state('');
	let identSig = $state('');

	function editIdentity(i: IdentityRow) {
		identEditing = i.id; identAccount = i.account_id;
		identEmail = i.email; identName = i.name; identSig = i.signature_html;
	}
	function newIdentity(accountId: number) {
		identEditing = 'new'; identAccount = accountId;
		identEmail = ''; identName = ''; identSig = '';
	}
	async function saveIdentity() {
		try {
			if (identEditing === 'new') {
				await apiPost('/api/accounts', { action: 'add-identity', accountId: identAccount, email: identEmail, name: identName, signatureHtml: identSig });
			} else {
				await apiPost('/api/accounts', { action: 'update-identity', identityId: identEditing, email: identEmail, name: identName, signatureHtml: identSig });
			}
			identEditing = null;
			await load();
			toasts.success('Identity saved');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}
	async function deleteIdentity(id: number) {
		try {
			await apiPost('/api/accounts', { action: 'delete-identity', identityId: id });
			await load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not delete');
		}
	}
	async function setDefaultIdentity(id: number) {
		try {
			await apiPost('/api/accounts', { action: 'set-default-identity', identityId: id });
			await load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not set default');
		}
	}

	const kindLabel: Record<string, string> = { imap: 'Mail (IMAP+SMTP)', pop3: 'Mail (POP3+SMTP)', caldav: 'Calendar/Tasks (CalDAV)', carddav: 'Contacts (CardDAV)' };
	const errorNames: Record<string, string> = { imap: 'IMAP', smtp: 'SMTP', pop3: 'POP3', dav: 'DAV', error: 'Connection' };
</script>

<svelte:head><title>Settings · Accounts — Slate</title></svelte:head>

<h2>Accounts</h2>
<p class="s-sub">Connections for the {data.profile.name} profile. Mail, calendar, and contacts can come from different servers.</p>

<div class="s-section">
	{#each accounts as a (a.id)}
		<div class="acc card">
			<div class="acc-head">
				<div>
					<div class="s-row-label">{a.name} <span class="kind">{kindLabel[a.kind] ?? a.kind}</span></div>
					<div class="s-row-help">
						{#if a.kind === 'imap' || a.kind === 'pop3'}{a.imap_host}:{a.imap_port} · SMTP {a.smtp_host}:{a.smtp_port}{:else}{a.dav_url}{/if}
						{#if a.allow_self_signed} · ⚠ self-signed allowed{/if}
					</div>
				</div>
				<span class="row-btns">
					<button class="btn-ghost" onclick={() => { pwAccount = a.id; pwValue = ''; }}>Update password</button>
					<button class="btn-ghost danger" onclick={() => void removeAccount(a.id)}>Remove</button>
				</span>
			</div>

			{#if pwAccount === a.id}
				<div class="inline-pw">
					<input class="input" type="password" placeholder="New password / app password" bind:value={pwValue} />
					<button class="btn btn-primary" onclick={() => void updatePw()}>Save</button>
					<button class="btn-ghost" onclick={() => (pwAccount = null)}>Cancel</button>
				</div>
			{/if}

			{#if a.kind === 'imap' || a.kind === 'pop3'}
				<div class="idents">
					<h4>Sender identities</h4>
					{#each identities.filter((i) => i.account_id === a.id) as i (i.id)}
						<div class="ident-row">
							<span class="ident-main">{i.name ? `${i.name} <${i.email}>` : i.email}{#if i.is_default}<span class="pill on">default</span>{/if}</span>
							<span class="row-btns">
								{#if !i.is_default}<button class="btn-ghost" onclick={() => void setDefaultIdentity(i.id)}>Make default</button>{/if}
								<button class="btn-ghost" onclick={() => editIdentity(i)}>Edit</button>
								<button class="btn-ghost danger" onclick={() => void deleteIdentity(i.id)}>Delete</button>
							</span>
						</div>
					{/each}
					<button class="btn-ghost add-ident" onclick={() => newIdentity(a.id)}>＋ Add identity / alias</button>
				</div>
			{/if}
		</div>
	{/each}

	{#if identEditing !== null}
		<div class="card ident-form">
			<h4>{identEditing === 'new' ? 'New identity' : 'Edit identity'}</h4>
			<label>Email address <input class="input" bind:value={identEmail} placeholder="alias@example.com" /></label>
			<label>Display name <input class="input" bind:value={identName} placeholder="Jamie Doe" /></label>
			<label>Signature (HTML allowed)
				<textarea class="input sig" bind:value={identSig} rows="4" placeholder="— Jamie"></textarea>
			</label>
			<div class="row-btns">
				<button class="btn btn-primary" onclick={() => void saveIdentity()} disabled={!identEmail.includes('@')}>Save identity</button>
				<button class="btn-ghost" onclick={() => (identEditing = null)}>Cancel</button>
			</div>
		</div>
	{/if}

	<h3>Add account</h3>
	<div class="add-grid">
		<button class="btn" onclick={() => openWizard('imap')}>✉️ Mail (IMAP+SMTP)</button>
		<button class="btn" onclick={() => openWizard('pop3')}>📥 Mail (POP3+SMTP)</button>
		<button class="btn" onclick={() => openWizard('caldav')}>🗓 Calendar/Tasks (CalDAV)</button>
		<button class="btn" onclick={() => openWizard('carddav')}>👤 Contacts (CardDAV)</button>
	</div>
</div>

{#if wizardOpen}
	<div class="overlay" role="dialog" aria-modal="true" aria-label="Add account">
		<div class="wizard glass">
			<header class="w-head">
				<strong>{kindLabel[kind]}</strong>
				<button class="btn-ghost" onclick={() => (wizardOpen = false)} aria-label="Close">✕</button>
			</header>

			<div class="w-body">
				<label>Preset
					<select class="input" bind:value={presetId} onchange={() => applyPreset(presetId)}>
						<option value="">Custom / manual</option>
						{#each presets.filter((p) => kind === 'imap' || kind === 'pop3' ? true : (kind === 'caldav' ? !!p.caldavUrl : !!p.carddavUrl)) as p (p.id)}
							<option value={p.id}>{p.name}</option>
						{/each}
					</select>
				</label>
				{#if presetNote}<p class="note">💡 {presetNote}</p>{/if}

				<label>Email address
					<span class="discover-row">
						<input class="input" type="email" bind:value={email} placeholder="you@example.com" onblur={() => void discover()} />
						<button class="btn" onclick={() => void discover()} disabled={discovering || !email.includes('@')}>
							{discovering ? 'Looking…' : 'Autodiscover'}
						</button>
					</span>
				</label>

				{#if kind === 'imap' || kind === 'pop3'}
					<div class="host-grid">
						<label>{kind === 'imap' ? 'IMAP' : 'POP3'} host <input class="input" bind:value={imapHost} placeholder={kind === 'imap' ? 'imap.example.com' : 'pop.example.com'} /></label>
						<label>Port <input class="input" type="number" bind:value={imapPort} /></label>
						<label>Security
							<select class="input" bind:value={imapSecurity}>
								<option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="none">None (insecure!)</option>
							</select>
						</label>
						<label>SMTP host <input class="input" bind:value={smtpHost} placeholder="smtp.example.com" /></label>
						<label>Port <input class="input" type="number" bind:value={smtpPort} /></label>
						<label>Security
							<select class="input" bind:value={smtpSecurity}>
								<option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="none">None (insecure!)</option>
							</select>
						</label>
					</div>
					{#if imapSecurity === 'none' || smtpSecurity === 'none'}
						<p class="warn">⚠️ “None” sends your password in plain text over the network. Only use on a trusted local network.</p>
					{/if}
				{:else}
					<label>Server URL <input class="input" bind:value={davUrl} placeholder="https://dav.example.com/dav/" /></label>
				{/if}

				<div class="host-grid two">
					<label>Username <input class="input" bind:value={username} placeholder="usually your email" /></label>
					<label>Password / app password <input class="input" type="password" bind:value={password} autocomplete="off" /></label>
				</div>

				<label class="check">
					<input type="checkbox" bind:checked={allowSelfSigned} />
					Accept self-signed certificates <span class="warn-inline">(⚠ weakens TLS security)</span>
				</label>

				{#if kind === 'imap' || kind === 'pop3'}
					<label>Account name <input class="input" bind:value={name} placeholder="Personal" /></label>
				{/if}

				{#if testResult}
					<div class="results" class:ok={testResult.ok}>
						{#each Object.entries(testResult.results) as [k, r] (k)}
							<div class="result-line">
								{r.ok ? '✅' : '❌'} {errorNames[k] ?? k}{r.ok ? ' — connected' : ` — ${r.error}`}
							</div>
						{/each}
					</div>
					{#if !testResult.ok}
						<label class="check">
							<input type="checkbox" bind:checked={overrideSave} />
							Save anyway (I know what I'm doing)
						</label>
					{/if}
				{/if}
			</div>

			<footer class="w-foot">
				<button class="btn" onclick={() => void test()} disabled={testing || !password}>
					{testing ? 'Testing…' : 'Test connection'}
				</button>
				<button class="btn btn-primary" onclick={() => void save()} disabled={saving || !password || (!testResult?.ok && !overrideSave)}>
					{saving ? 'Saving…' : 'Connect account'}
				</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.acc { padding: 14px 16px; margin-bottom: 10px; }
	.acc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
	.kind { font-size: 11px; color: var(--text-3); border: 1px solid var(--border); border-radius: 99px; padding: 2px 8px; margin-left: 6px; }
	.row-btns { display: flex; gap: 6px; flex-wrap: wrap; }
	.danger { color: var(--danger); }
	.inline-pw { display: flex; gap: 6px; margin-top: 10px; }
	.idents { margin-top: 12px; border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); padding-top: 10px; }
	.idents h4, .ident-form h4 { font-size: 12px; color: var(--text-3); margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.05em; }
	.ident-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 5px 0; font-size: 13px; }
	.ident-main { display: flex; gap: 8px; align-items: center; }
	.pill { font-size: 11px; border: 1px solid var(--border); border-radius: 99px; padding: 1px 8px; color: var(--text-3); }
	.pill.on { color: var(--accent); border-color: var(--accent); }
	.add-ident { margin-top: 4px; font-size: 12.5px; }
	.ident-form { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
	.ident-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-2); }
	.sig { font-family: inherit; resize: vertical; }
	.add-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }

	.overlay {
		position: fixed; inset: 0; z-index: 90;
		background: rgb(0 0 0 / 0.4);
		display: grid; place-items: center; padding: 20px;
	}
	.wizard {
		width: min(560px, 100%); max-height: 90vh;
		border-radius: var(--r-3); border: 1px solid var(--border);
		display: flex; flex-direction: column;
		box-shadow: var(--shadow-3);
		animation: pop var(--dur-2) var(--ease-spring);
	}
	@keyframes pop { from { transform: scale(0.96) translateY(8px); opacity: 0; } }
	.w-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--border); }
	.w-body { padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
	.w-body label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-2); }
	.w-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 18px; border-top: 1px solid var(--border); }
	.host-grid { display: grid; grid-template-columns: 2fr 72px 1fr; gap: 8px; }
	.host-grid.two { grid-template-columns: 1fr 1fr; }
	.discover-row { display: flex; gap: 6px; }
	.discover-row .input { flex: 1; }
	.check { flex-direction: row !important; align-items: center; gap: 8px !important; }
	.note { font-size: 12.5px; color: var(--text-2); background: color-mix(in oklab, var(--accent) 8%, transparent); border-radius: var(--r-2); padding: 8px 10px; margin: 0; }
	.warn { font-size: 12.5px; color: var(--warn); margin: 0; }
	.warn-inline { color: var(--warn); font-size: 11.5px; }
	.results { border: 1px solid var(--danger); border-radius: var(--r-2); padding: 10px 12px; font-size: 13px; display: flex; flex-direction: column; gap: 4px; }
	.results.ok { border-color: var(--success); }
	@media (max-width: 560px) { .host-grid { grid-template-columns: 1fr; } }
</style>
