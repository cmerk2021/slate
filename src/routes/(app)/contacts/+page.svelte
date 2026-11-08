<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { sse } from '$lib/client/sse.svelte';
	import { initials, avatarHue } from '$lib/client/format';
	import { goto } from '$app/navigation';

	let { data } = $props();

	interface Book { id: number; name: string; account_name: string }
	interface ListContact { id: number; addressbookId: number; fn: string; emails: { type: string; value: string }[]; phones: { type: string; value: string }[]; org: string | null; photo: string | null }
	interface Detail {
		id: number; addressbookId: number; bookName: string;
		uid: string; fn: string; firstName: string; lastName: string;
		emails: { type: string; value: string }[]; phones: { type: string; value: string }[];
		addresses: { type: string; value: string }[];
		org: string; title: string; bday: string; note: string;
		photo: string | null; groups: string[];
	}

	let books = $state<Book[]>([]);
	let contacts = $state<ListContact[]>([]);
	let loading = $state(true);
	let filterBook = $state<number | 0>(0);
	let query = $state('');
	let selected = $state<Detail | null>(null);
	let editing = $state(false);
	let draft = $state<Partial<Detail>>({});
	let busy = $state(false);
	let recent = $state<{ id: number; subject: string; date: number }[]>([]);

	async function load() {
		try {
			const [b, c] = await Promise.all([
				apiGet<{ books: Book[] }>(`/api/contacts?profile=${data.profile.id}&view=books`),
				apiGet<{ contacts: ListContact[] }>(`/api/contacts?profile=${data.profile.id}&view=list`)
			]);
			books = b.books;
			contacts = c.contacts;
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not load contacts');
		} finally {
			loading = false;
		}
	}

	$effect(() => { void data.profile.id; loading = true; void load(); });
	$effect(() => sse.on('contacts', () => void load()));

	const filtered = $derived.by(() => {
		let out = contacts;
		if (filterBook) out = out.filter((c) => c.addressbookId === filterBook);
		const q = query.trim().toLowerCase();
		if (q) out = out.filter((c) =>
			c.fn.toLowerCase().includes(q) ||
			c.emails.some((e) => e.value.toLowerCase().includes(q)) ||
			(c.org ?? '').toLowerCase().includes(q)
		);
		return out;
	});

	/** group by first letter for the alphabetical index */
	const grouped = $derived.by(() => {
		const groups = new Map<string, ListContact[]>();
		for (const c of filtered) {
			const letter = (c.fn[0] ?? '#').toUpperCase();
			const key = /[A-Z]/.test(letter) ? letter : '#';
			groups.set(key, [...(groups.get(key) ?? []), c]);
		}
		return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
	});

	/** naive duplicate suggestion: same email or same full name */
	const duplicates = $derived.by(() => {
		const seenEmail = new Map<string, ListContact>();
		const seenName = new Map<string, ListContact>();
		const pairs: [ListContact, ListContact][] = [];
		for (const c of contacts) {
			const nameKey = c.fn.trim().toLowerCase();
			if (nameKey && seenName.has(nameKey) && seenName.get(nameKey)!.id !== c.id) {
				pairs.push([seenName.get(nameKey)!, c]);
			} else if (nameKey) seenName.set(nameKey, c);
			for (const e of c.emails) {
				const k = e.value.toLowerCase();
				if (k && seenEmail.has(k) && seenEmail.get(k)!.id !== c.id) {
					if (!pairs.some(([a, b]) => (a.id === seenEmail.get(k)!.id && b.id === c.id))) pairs.push([seenEmail.get(k)!, c]);
				} else if (k) seenEmail.set(k, c);
			}
		}
		return pairs.slice(0, 3);
	});

	async function open(c: ListContact) {
		editing = false;
		try {
			const res = await apiGet<{ contact: Detail }>(`/api/contacts?profile=${data.profile.id}&view=detail&id=${c.id}`);
			selected = res.contact;
			void loadRecent(res.contact);
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not load contact');
		}
	}

	async function loadRecent(c: Detail) {
		recent = [];
		const email = c.emails[0]?.value;
		if (!email) return;
		try {
			const res = await apiGet<{ local: { id: number; subject: string; date: number }[] }>(`/api/search?profile=${data.profile.id}&q=${encodeURIComponent('from:' + email)}`);
			recent = res.local.slice(0, 5);
		} catch { /* non-fatal */ }
	}

	function startNew() {
		if (books.length === 0) { toasts.error('Connect a CardDAV account first.'); return; }
		selected = null;
		editing = true;
		draft = { addressbookId: books[0].id, firstName: '', lastName: '', emails: [{ type: 'home', value: '' }], phones: [], addresses: [], org: '', title: '', bday: '', note: '', groups: [] };
	}

	function startEdit() {
		if (!selected) return;
		editing = true;
		draft = JSON.parse(JSON.stringify(selected));
		if (!draft.emails?.length) draft.emails = [{ type: 'home', value: '' }];
	}

	async function save() {
		busy = true;
		const contact = {
			uid: (draft as Detail).uid,
			firstName: draft.firstName ?? '', lastName: draft.lastName ?? '',
			emails: (draft.emails ?? []).filter((e) => e.value.trim()),
			phones: (draft.phones ?? []).filter((p) => p.value.trim()),
			addresses: (draft.addresses ?? []).filter((a) => a.value.trim()),
			org: draft.org, title: draft.title, bday: draft.bday, note: draft.note,
			photo: draft.photo, groups: draft.groups
		};
		if (!contact.firstName && !contact.lastName && !contact.emails.length) {
			toasts.error('Add at least a name or an email'); busy = false; return;
		}
		try {
			if (selected) {
				await apiPost('/api/contacts', { action: 'update', contactId: selected.id, contact });
				toasts.success('Contact saved');
			} else {
				await apiPost('/api/contacts', { action: 'create', addressbookId: draft.addressbookId, contact });
				toasts.success('Contact created');
			}
			editing = false;
			selected = null;
			void load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		} finally {
			busy = false;
		}
	}

	async function del() {
		if (!selected) return;
		if (!confirm(`Delete ${selected.fn}?`)) return;
		try {
			await apiPost('/api/contacts', { action: 'delete', contactId: selected.id });
			toasts.show('Contact deleted');
			selected = null;
			void load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not delete');
		}
	}

	async function merge(a: ListContact, b: ListContact) {
		try {
			const [da, dbb] = await Promise.all([
				apiGet<{ contact: Detail }>(`/api/contacts?profile=${data.profile.id}&view=detail&id=${a.id}`),
				apiGet<{ contact: Detail }>(`/api/contacts?profile=${data.profile.id}&view=detail&id=${b.id}`)
			]);
			const A = da.contact, B = dbb.contact;
			const mergeArr = <T extends { value: string }>(x: T[], y: T[]) => {
				const seen = new Set(x.map((i) => i.value.toLowerCase()));
				return [...x, ...y.filter((i) => !seen.has(i.value.toLowerCase()))];
			};
			await apiPost('/api/contacts', {
				action: 'merge', primaryId: A.id, secondaryId: B.id,
				contact: {
					uid: A.uid,
					firstName: A.firstName || B.firstName, lastName: A.lastName || B.lastName,
					emails: mergeArr(A.emails, B.emails), phones: mergeArr(A.phones, B.phones),
					addresses: mergeArr(A.addresses, B.addresses),
					org: A.org || B.org, title: A.title || B.title, bday: A.bday || B.bday,
					note: [A.note, B.note].filter(Boolean).join('\n'), photo: A.photo || B.photo,
					groups: [...new Set([...A.groups, ...B.groups])]
				}
			});
			toasts.success('Contacts merged');
			selected = null;
			void load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not merge');
		}
	}

	function composeTo(email: string) {
		void goto(`/mail?compose=new&to=${encodeURIComponent(email)}`);
	}

	function fullName(d: Partial<Detail>): string {
		return [d.firstName, d.lastName].filter(Boolean).join(' ') || d.emails?.[0]?.value || 'New contact';
	}
</script>

<svelte:head><title>Contacts — Slate</title></svelte:head>

<div class="contacts-page">
	<section class="c-list-col" aria-label="Contacts">
		<header class="c-head">
			<h1>Contacts</h1>
			<span class="c-count tnum">{filtered.length}</span>
			<span class="grow"></span>
			<button class="btn btn-primary" onclick={startNew}>+ New</button>
		</header>
		<div class="c-tools">
			<input class="c-search" type="search" placeholder="Search contacts" bind:value={query} aria-label="Search contacts" />
			{#if books.length > 1}
				<select class="input" bind:value={filterBook} aria-label="Address book filter">
					<option value={0}>All books</option>
					{#each books as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
				</select>
			{/if}
		</div>

		{#if duplicates.length > 0 && !query}
			<div class="dupes">
				{#each duplicates as [a, b] (a.id + '-' + b.id)}
					<div class="dupe-row">
						<span class="trunc">Possible duplicate: <strong>{a.fn}</strong> & <strong>{b.fn}</strong></span>
						<button class="mini-btn" onclick={() => void merge(a, b)}>Merge</button>
					</div>
				{/each}
			</div>
		{/if}

		{#if loading}
			<div class="c-skels">{#each Array(8) as _, i (i)}<div class="skeleton c-skel"></div>{/each}</div>
		{:else if books.length === 0}
			<div class="c-empty">
				<div class="empty-art">👥</div>
				<p>No address books yet.</p>
				<a class="btn" href="/settings/accounts">Connect a CardDAV account</a>
			</div>
		{:else if filtered.length === 0}
			<div class="c-empty"><div class="empty-art">🔍</div><p>No contacts found.</p></div>
		{:else}
			<div class="c-scroll">
				{#each grouped as [letter, cs] (letter)}
					<div class="c-letter" id="letter-{letter}">{letter}</div>
					{#each cs as c (c.id)}
						<button class="c-row" class:sel={selected?.id === c.id} onclick={() => void open(c)}>
							{#if c.photo}
								<img class="c-avatar" src={c.photo} alt="" />
							{:else}
								<span class="c-avatar txt" style="background: hsl({avatarHue(c.fn)} 40% 40%)">{initials(c.fn)}</span>
							{/if}
							<span class="c-info">
								<span class="c-name trunc">{c.fn || '(no name)'}</span>
								<span class="c-sub trunc">{c.emails[0]?.value ?? c.org ?? ''}</span>
							</span>
						</button>
					{/each}
				{/each}
			</div>
			<nav class="alpha-index" aria-label="Alphabetical index">
				{#each grouped as [letter] (letter)}
					<a href="#letter-{letter}">{letter}</a>
				{/each}
			</nav>
		{/if}
	</section>

	<section class="c-detail" aria-label="Contact detail">
		{#if editing}
			<div class="d-card card">
				<h2>{selected ? 'Edit contact' : 'New contact'}</h2>
				{#if !selected && books.length > 1}
					<label class="f-lbl">Address book
						<select class="input" bind:value={draft.addressbookId}>
							{#each books as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
						</select>
					</label>
				{/if}
				<div class="f-two">
					<label class="f-lbl">First name<input class="input" type="text" bind:value={draft.firstName} /></label>
					<label class="f-lbl">Last name<input class="input" type="text" bind:value={draft.lastName} /></label>
				</div>
				<div class="f-two">
					<label class="f-lbl">Organization<input class="input" type="text" bind:value={draft.org} /></label>
					<label class="f-lbl">Title<input class="input" type="text" bind:value={draft.title} /></label>
				</div>

				<fieldset class="f-set">
					<legend>Emails</legend>
					{#each draft.emails ?? [] as e, i (i)}
						<div class="f-multi">
							<select class="input sm" bind:value={e.type}><option>home</option><option>work</option><option>other</option></select>
							<input class="input" type="email" bind:value={e.value} placeholder="email@example.com" />
							<button class="mini-btn" onclick={() => (draft.emails = draft.emails!.toSpliced(i, 1))} aria-label="Remove">✕</button>
						</div>
					{/each}
					<button class="mini-btn" onclick={() => (draft.emails = [...(draft.emails ?? []), { type: 'home', value: '' }])}>+ email</button>
				</fieldset>

				<fieldset class="f-set">
					<legend>Phones</legend>
					{#each draft.phones ?? [] as p, i (i)}
						<div class="f-multi">
							<select class="input sm" bind:value={p.type}><option>cell</option><option>home</option><option>work</option></select>
							<input class="input" type="tel" bind:value={p.value} placeholder="+1 555 0100" />
							<button class="mini-btn" onclick={() => (draft.phones = draft.phones!.toSpliced(i, 1))} aria-label="Remove">✕</button>
						</div>
					{/each}
					<button class="mini-btn" onclick={() => (draft.phones = [...(draft.phones ?? []), { type: 'cell', value: '' }])}>+ phone</button>
				</fieldset>

				<fieldset class="f-set">
					<legend>Addresses</legend>
					{#each draft.addresses ?? [] as a, i (i)}
						<div class="f-multi">
							<select class="input sm" bind:value={a.type}><option>home</option><option>work</option></select>
							<input class="input" type="text" bind:value={a.value} placeholder="Street, City, Country" />
							<button class="mini-btn" onclick={() => (draft.addresses = draft.addresses!.toSpliced(i, 1))} aria-label="Remove">✕</button>
						</div>
					{/each}
					<button class="mini-btn" onclick={() => (draft.addresses = [...(draft.addresses ?? []), { type: 'home', value: '' }])}>+ address</button>
				</fieldset>

				<div class="f-two">
					<label class="f-lbl">Birthday<input class="input" type="date" bind:value={draft.bday} /></label>
					<label class="f-lbl">Groups<input class="input" type="text" value={(draft.groups ?? []).join(', ')} onchange={(e) => (draft.groups = (e.target as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean))} placeholder="friends, book club" /></label>
				</div>
				<label class="f-lbl">Notes<textarea class="input" rows="3" bind:value={draft.note}></textarea></label>

				<footer class="f-foot">
					<button class="btn btn-ghost" onclick={() => (editing = false)}>Cancel</button>
					<button class="btn btn-primary" onclick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
				</footer>
			</div>
		{:else if selected}
			<div class="d-card card">
				<div class="d-top">
					{#if selected.photo}
						<img class="d-avatar" src={selected.photo} alt="" />
					{:else}
						<span class="d-avatar txt" style="background: hsl({avatarHue(selected.fn)} 40% 40%)">{initials(selected.fn)}</span>
					{/if}
					<div class="d-id">
						<h2>{selected.fn || '(no name)'}</h2>
						{#if selected.title || selected.org}
							<p class="d-org">{[selected.title, selected.org].filter(Boolean).join(' · ')}</p>
						{/if}
						<p class="d-book">{selected.bookName}</p>
					</div>
					<span class="grow"></span>
					<button class="btn" onclick={startEdit}>Edit</button>
					<button class="btn danger-btn" onclick={() => void del()}>Delete</button>
				</div>

				{#each selected.emails as e (e.value)}
					<div class="d-row">
						<span class="d-type">{e.type || 'email'}</span>
						<a href="mailto:{e.value}" onclick={(ev) => { ev.preventDefault(); composeTo(e.value); }}>{e.value}</a>
						<button class="mini-btn" onclick={() => composeTo(e.value)}>✉ Compose</button>
					</div>
				{/each}
				{#each selected.phones as p (p.value)}
					<div class="d-row"><span class="d-type">{p.type || 'phone'}</span><a href="tel:{p.value}">{p.value}</a></div>
				{/each}
				{#each selected.addresses as a, i (i)}
					<div class="d-row"><span class="d-type">{a.type || 'address'}</span><span>{a.value}</span></div>
				{/each}
				{#if selected.bday}
					<div class="d-row"><span class="d-type">birthday</span><span>{selected.bday}</span></div>
				{/if}
				{#if selected.groups.length}
					<div class="d-row"><span class="d-type">groups</span><span>{selected.groups.join(', ')}</span></div>
				{/if}
				{#if selected.note}
					<div class="d-row note"><span class="d-type">notes</span><span class="d-note">{selected.note}</span></div>
				{/if}

				{#if recent.length > 0}
					<h3 class="d-recent-h">Recent conversations</h3>
					{#each recent as r (r.id)}
						<a class="d-recent" href="/mail?message={r.id}">
							<span class="trunc">{r.subject || '(no subject)'}</span>
							<span class="d-recent-date tnum">{new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
						</a>
					{/each}
				{/if}
			</div>
		{:else}
			<div class="c-empty">
				<div class="empty-art">💌</div>
				<p>Select a contact</p>
			</div>
		{/if}
	</section>
</div>

<style>
	.contacts-page { display: flex; height: 100%; min-height: 0; }
	.c-list-col {
		width: 360px; flex: none;
		border-right: 1px solid var(--border);
		display: flex; flex-direction: column; min-height: 0;
		position: relative;
	}
	.c-head { display: flex; align-items: center; gap: 10px; padding: 16px 16px 6px; }
	.c-head h1 { font-family: var(--font-display); font-size: 20px; font-weight: 650; margin: 0; }
	.c-count { color: var(--text-3); font-size: 12.5px; }
	.grow { flex: 1; }
	.c-tools { display: flex; gap: 8px; padding: 4px 16px 10px; }
	.c-search {
		flex: 1;
		background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-2);
		padding: 8px 12px; color: var(--text-1); font-family: inherit; font-size: 13px; outline: none;
	}
	.c-search:focus { border-color: var(--accent); }
	.dupes { padding: 0 16px 8px; }
	.dupe-row {
		display: flex; align-items: center; gap: 8px;
		background: color-mix(in oklab, var(--warn) 10%, var(--surface-1));
		border: 1px solid color-mix(in oklab, var(--warn) 30%, transparent);
		border-radius: var(--r-2); padding: 6px 10px; margin-bottom: 4px;
		font-size: 12px;
	}
	.mini-btn { background: none; border: 1px solid var(--border); color: var(--text-2); font-family: inherit; font-size: 12px; padding: 3px 9px; border-radius: var(--r-1); cursor: pointer; }
	.mini-btn:hover { background: var(--surface-2); color: var(--text-1); }
	.c-skels { padding: 8px 16px; }
	.c-skel { height: 52px; border-radius: var(--r-2); margin-bottom: 8px; }
	.c-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-3); padding: 40px; }
	.empty-art { font-size: 40px; }
	.c-scroll { flex: 1; overflow-y: auto; padding: 0 10px 20px; }
	.c-letter {
		position: sticky; top: 0; z-index: 5;
		background: var(--bg);
		font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--accent);
		padding: 8px 10px 3px;
	}
	.c-row {
		display: flex; align-items: center; gap: 10px;
		width: 100%; background: none; border: none; cursor: pointer;
		font-family: inherit; text-align: left;
		padding: 7px 10px; border-radius: var(--r-2);
		transition: background var(--dur-1);
	}
	.c-row:hover { background: var(--surface-1); }
	.c-row.sel { background: color-mix(in oklab, var(--accent) 12%, transparent); }
	.c-avatar { width: 36px; height: 36px; border-radius: 50%; flex: none; object-fit: cover; }
	.c-avatar.txt { display: grid; place-items: center; color: white; font-size: 13px; font-weight: 600; }
	.c-info { min-width: 0; display: flex; flex-direction: column; }
	.c-name { font-size: 13.5px; font-weight: 580; color: var(--text-1); }
	.c-sub { font-size: 12px; color: var(--text-3); }
	.alpha-index {
		position: absolute; right: 2px; top: 120px; bottom: 20px;
		display: flex; flex-direction: column; justify-content: center;
		gap: 1px;
	}
	.alpha-index a { font-size: 9.5px; color: var(--text-3); text-decoration: none; padding: 0 4px; }
	.alpha-index a:hover { color: var(--accent); }

	.c-detail { flex: 1; min-width: 0; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; }
	.d-card { max-width: 640px; width: 100%; margin: 0 auto; padding: 24px; }
	.d-top { display: flex; gap: 16px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
	.d-avatar { width: 64px; height: 64px; border-radius: 50%; flex: none; object-fit: cover; }
	.d-avatar.txt { display: grid; place-items: center; color: white; font-size: 22px; font-weight: 600; }
	.d-id h2 { font-family: var(--font-display); font-size: 22px; margin: 0; }
	.d-org { margin: 2px 0 0; color: var(--text-2); font-size: 13px; }
	.d-book { margin: 2px 0 0; color: var(--text-3); font-size: 11.5px; }
	.danger-btn { color: var(--danger); }
	.d-row { display: flex; align-items: baseline; gap: 12px; padding: 8px 0; border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); font-size: 13.5px; }
	.d-type { width: 72px; flex: none; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-3); }
	.d-row a { color: var(--accent); text-decoration: none; }
	.d-row a:hover { text-decoration: underline; }
	.d-note { white-space: pre-wrap; }
	.d-recent-h { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); margin: 20px 0 6px; }
	.d-recent {
		display: flex; justify-content: space-between; gap: 12px;
		padding: 8px 10px; border-radius: var(--r-1);
		color: var(--text-1); text-decoration: none; font-size: 13px;
	}
	.d-recent:hover { background: var(--surface-1); }
	.d-recent-date { color: var(--text-3); font-size: 12px; flex: none; }

	h2 { font-family: var(--font-display); font-size: 19px; margin: 0 0 14px; }
	.f-lbl { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-3); margin-bottom: 10px; flex: 1; }
	.f-two { display: flex; gap: 10px; }
	.f-set { border: 1px solid var(--border); border-radius: var(--r-2); padding: 10px 12px; margin-bottom: 12px; }
	.f-set legend { font-size: 12px; color: var(--text-3); padding: 0 6px; }
	.f-multi { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
	.f-multi .input { flex: 1; }
	.input.sm { flex: none !important; width: 86px; }
	.f-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
	textarea.input { resize: vertical; font-family: inherit; }
	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	@media (max-width: 860px) {
		.contacts-page { flex-direction: column; }
		.c-list-col { width: 100%; max-height: 45%; border-right: none; border-bottom: 1px solid var(--border); }
	}
</style>
