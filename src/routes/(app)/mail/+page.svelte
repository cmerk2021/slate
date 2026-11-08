<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { apiGet, apiPost, apiPut } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { sse } from '$lib/client/sse.svelte';
	import { shortcuts } from '$lib/client/shortcuts.svelte';
	import { fmtTime } from '$lib/client/format';
	import MessageList, { type ListMessage } from '$lib/components/mail/MessageList.svelte';
	import ReadingPane, { type MessageDetail } from '$lib/components/mail/ReadingPane.svelte';
	import Composer, { type ComposerPrefill, type Identity } from '$lib/components/mail/Composer.svelte';

	let { data } = $props();

	// ---------- view state from url ----------
	const folderParam = $derived(page.url.searchParams.get('folder'));
	const snoozedView = $derived(page.url.searchParams.get('view') === 'snoozed');
	const unifiedView = $derived(page.url.searchParams.get('unified') === '1');
	const messageParam = $derived(page.url.searchParams.get('message'));
	const composeParam = $derived(page.url.searchParams.get('compose'));

	const inboxes = $derived(data.folders.filter((f) => f.role === 'inbox'));
	const currentFolder = $derived(
		folderParam
			? data.folders.find((f) => f.id === parseInt(folderParam, 10)) ?? null
			: snoozedView || unifiedView ? null : inboxes[0] ?? null
	);
	const isInbox = $derived(unifiedView || currentFolder?.role === 'inbox');
	const viewTitle = $derived(
		snoozedView ? 'Snoozed' : unifiedView ? 'All inboxes' : currentFolder ? currentFolder.name : 'Mail'
	);

	// ---------- messages ----------
	let messages = $state<ListMessage[]>([]);
	let loading = $state(false);
	let loadingMore = $state(false);
	let exhausted = $state(false);
	let listError = $state('');
	let activeSplit = $state<string>('all');
	let splits = $state<{ id: number; name: string; rules_json: string }[]>([]);
	let listEl = $state<ReturnType<typeof MessageList> | null>(null);

	let selectedId = $state<number | null>(null);
	let checkedIds = $state(new Set<number>());
	let lastCheckedId: number | null = null;

	// ---------- reading ----------
	let detail = $state<MessageDetail | null>(null);
	let detailLoading = $state(false);
	let detailError = $state('');
	let thread = $state<ListMessage[]>([]);
	let mobileReading = $state(false);

	// ---------- search ----------
	let searchQ = $state('');
	let searchActive = $state(false);
	let searchResults = $state<(ListMessage & { source?: string })[]>([]);
	let searchBusy = $state(false);
	let searchTimer: ReturnType<typeof setTimeout> | null = null;
	let searchInputEl = $state<HTMLInputElement | null>(null);

	// ---------- composers ----------
	let composers = $state<{ key: number; prefill: ComposerPrefill }[]>([]);
	let composerKey = 0;
	let identities = $state<Identity[]>([]);

	// ---------- misc ui ----------
	let snoozeMenuFor = $state<number[] | null>(null);
	let moveMenuOpen = $state(false);
	let splitEditorOpen = $state(false);
	let triageMode = $state(false);
	let triageQueue = $state<ListMessage[]>([]);
	let customSnooze = $state('');
	let connections = $state<{ accountId: number; status: string; error?: string }[]>([]);

	// resizable list pane
	let listWidth = $state(380);
	let resizing = false;
	const paneMode = $derived((data.profileSettings['reading_pane'] as string) ?? data.settings.readingPane);

	$effect(() => {
		if (browser) {
			const w = localStorage.getItem('slate-list-width');
			if (w) listWidth = Math.max(260, Math.min(640, parseInt(w, 10)));
		}
	});

	function startResize(e: PointerEvent) {
		resizing = true;
		const startX = e.clientX;
		const startW = listWidth;
		const move = (ev: PointerEvent) => {
			if (!resizing) return;
			listWidth = Math.max(260, Math.min(640, startW + ev.clientX - startX));
		};
		const up = () => {
			resizing = false;
			localStorage.setItem('slate-list-width', String(listWidth));
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	// ---------- data loading ----------
	const displayed = $derived(searchActive ? searchResults : messages);

	function listQuery(offset: number): string {
		const p = new URLSearchParams({ view: 'list', profile: String(data.profile.id), offset: String(offset), limit: '100' });
		if (snoozedView) p.set('snoozed', '1');
		else if (unifiedView) p.set('unified', '1');
		else if (currentFolder) p.set('folder', String(currentFolder.id));
		if (isInbox && activeSplit !== 'all') p.set('split', activeSplit);
		return `/api/mail?${p}`;
	}

	async function loadList() {
		loading = true;
		listError = '';
		exhausted = false;
		try {
			const res = await apiGet<{ messages: ListMessage[] }>(listQuery(0));
			messages = res.messages;
			if (res.messages.length < 100) exhausted = true;
		} catch (e) {
			listError = e instanceof Error ? e.message : 'Failed to load messages';
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || exhausted || searchActive) return;
		loadingMore = true;
		try {
			const res = await apiGet<{ messages: ListMessage[] }>(listQuery(messages.length));
			if (res.messages.length === 0) {
				// try fetching older messages from the server
				if (currentFolder && !snoozedView) {
					const older = await apiPost<{ ok: boolean; added: number }>('/api/mail', { action: 'load-older', accountId: currentFolder.account_id, folderId: currentFolder.id });
					if (older.added > 0) {
						const again = await apiGet<{ messages: ListMessage[] }>(listQuery(messages.length));
						if (again.messages.length > 0) {
							messages = dedupe([...messages, ...again.messages]);
							return;
						}
					}
				}
				exhausted = true;
			} else {
				messages = dedupe([...messages, ...res.messages]);
			}
		} catch { /* transient */ } finally {
			loadingMore = false;
		}
	}

	function dedupe(list: ListMessage[]): ListMessage[] {
		const seen = new Set<number>();
		return list.filter((m) => !seen.has(m.id) && seen.add(m.id));
	}

	async function loadSplits() {
		try {
			const res = await apiGet<{ splits: typeof splits }>(`/api/mail?view=splits&profile=${data.profile.id}`);
			splits = res.splits;
		} catch { splits = []; }
	}

	async function loadIdentities() {
		try {
			const res = await apiGet<{ identities: Identity[] }>(`/api/mail?view=identities&profile=${data.profile.id}`);
			identities = res.identities;
		} catch { identities = []; }
	}

	async function loadConnections() {
		try {
			const res = await apiGet<{ connections: typeof connections }>(`/api/mail?view=folders&profile=${data.profile.id}`);
			connections = res.connections;
		} catch { /* non-fatal */ }
	}

	// react to folder / view / split changes
	let lastViewKey = '';
	$effect(() => {
		const key = `${data.profile.id}|${currentFolder?.id ?? ''}|${snoozedView}|${unifiedView}|${activeSplit}`;
		if (key !== lastViewKey) {
			lastViewKey = key;
			selectedId = null;
			detail = null;
			checkedIds = new Set();
			mobileReading = false;
			void loadList();
		}
	});

	$effect(() => {
		void data.profile.id;
		void loadSplits();
		void loadIdentities();
		void loadConnections();
	});

	// open message from url param (deep links)
	$effect(() => {
		if (messageParam) {
			const id = parseInt(messageParam, 10);
			if (id && id !== selectedId) void openById(id);
		}
	});

	// open composer from url param
	$effect(() => {
		if (composeParam === 'new') {
			const to = page.url.searchParams.get('to');
			openComposer({ mode: 'new', to: to ? [{ name: '', address: to }] : undefined });
			const u = new URL(page.url);
			u.searchParams.delete('compose');
			u.searchParams.delete('to');
			void goto(u, { replaceState: true, noScroll: true });
		}
	});

	// SSE live updates
	$effect(() => {
		const offs = [
			sse.on('mail', () => { if (!searchActive) void loadList(); void invalidateAll(); }),
			sse.on('snooze-wake', () => { void loadList(); void invalidateAll(); }),
			sse.on('connection', () => void loadConnections())
		];
		return () => offs.forEach((f) => f());
	});

	// ---------- open / read ----------
	async function openMessage(m: ListMessage) {
		selectedId = m.id;
		mobileReading = true;
		await loadDetail(m.id);
		if (m.threadKey && (m.threadCount ?? 1) > 1) {
			try {
				const res = await apiGet<{ messages: ListMessage[] }>(`/api/mail?view=thread&profile=${data.profile.id}&key=${encodeURIComponent(m.threadKey)}`);
				thread = res.messages;
			} catch { thread = []; }
		} else {
			thread = [];
		}
		// optimistic mark-seen in list
		const idx = messages.findIndex((x) => x.id === m.id);
		if (idx >= 0 && !messages[idx].seen) {
			messages[idx] = { ...messages[idx], seen: true };
			messages = [...messages];
		}
	}

	async function openById(id: number) {
		selectedId = id;
		mobileReading = true;
		await loadDetail(id);
	}

	async function loadDetail(id: number, params: { images?: boolean; adapt?: boolean } = {}) {
		detailLoading = true;
		detailError = '';
		try {
			const p = new URLSearchParams({ view: 'message', profile: String(data.profile.id), id: String(id) });
			if (params.images) p.set('images', '1');
			if (isDark) p.set('dark', '1');
			if (params.adapt === false) p.set('adapt', '0');
			detail = await apiGet<MessageDetail>(`/api/mail?${p}`);
		} catch (e) {
			detail = null;
			detailError = e instanceof Error ? e.message : 'Could not load this message';
		} finally {
			detailLoading = false;
		}
	}

	const isDark = $derived.by(() => {
		const theme = (data.profile.theme as string) || data.settings.theme;
		return theme !== 'paper-light';
	});

	function closeReading() {
		mobileReading = false;
		selectedId = null;
		detail = null;
		thread = [];
		if (messageParam) {
			const u = new URL(page.url);
			u.searchParams.delete('message');
			void goto(u, { replaceState: true, noScroll: true });
		}
	}

	// ---------- selection ----------
	function toggleCheck(m: ListMessage, shift: boolean) {
		const next = new Set(checkedIds);
		if (shift && lastCheckedId !== null) {
			const list = displayed;
			const a = list.findIndex((x) => x.id === lastCheckedId);
			const b = list.findIndex((x) => x.id === m.id);
			if (a >= 0 && b >= 0) {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				for (let i = lo; i <= hi; i++) next.add(list[i].id);
			}
		} else if (next.has(m.id)) next.delete(m.id);
		else next.add(m.id);
		checkedIds = next;
		lastCheckedId = m.id;
	}

	function selectAll() {
		checkedIds = checkedIds.size === displayed.length ? new Set() : new Set(displayed.map((m) => m.id));
	}

	const actionTargets = $derived(checkedIds.size > 0 ? [...checkedIds] : selectedId !== null ? [selectedId] : []);

	// ---------- triage actions (optimistic + undo) ----------
	function removeFromList(ids: number[]) {
		const removed = messages.filter((m) => ids.includes(m.id));
		messages = messages.filter((m) => !ids.includes(m.id));
		if (selectedId !== null && ids.includes(selectedId)) {
			advanceSelection(removed);
		}
		checkedIds = new Set([...checkedIds].filter((id) => !ids.includes(id)));
		return removed;
	}

	function advanceSelection(removed: ListMessage[]) {
		// after triaging the open message, open the next one (nice for triage flow)
		if (triageMode && triageQueue.length > 0) {
			triageQueue = triageQueue.filter((m) => !removed.some((r) => r.id === m.id));
			if (triageQueue.length > 0) void openMessage(triageQueue[0]);
			else { triageMode = false; closeReading(); toasts.success('Inbox triaged — nice work ✨'); }
			return;
		}
		closeReading();
	}

	async function act(action: string, ids: number[], extra: Record<string, unknown> = {}, undoMsg?: string) {
		if (ids.length === 0) return;
		const removed = removeFromList(ids);
		const originFolders = new Map(removed.map((m) => [m.id, m.folderId]));
		try {
			await apiPost('/api/mail', { action, ids, ...extra });
			void invalidateAll();
			if (undoMsg) {
				toasts.undoable(undoMsg, {
					onUndo: async () => {
						try {
							if (action === 'snooze') await apiPost('/api/mail', { action: 'unsnooze', ids });
							else if (action === 'archive' || action === 'delete' || action === 'spam' || action === 'move') {
								// move back to original folders (grouped)
								const groups = new Map<number, number[]>();
								for (const id of ids) {
									const f = originFolders.get(id);
									if (f) groups.set(f, [...(groups.get(f) ?? []), id]);
								}
								for (const [folderId, group] of groups) await apiPost('/api/mail', { action: 'move', ids: group, folderId });
							}
							void loadList();
							void invalidateAll();
						} catch { toasts.error('Could not undo'); }
					}
				});
			}
		} catch (e) {
			// restore on failure
			messages = dedupe([...removed, ...messages]).sort((a, b) => b.date - a.date);
			toasts.error(e instanceof Error ? e.message : 'Action failed');
		}
	}

	const archive = (ids: number[]) => act('archive', ids, {}, ids.length > 1 ? `${ids.length} archived` : 'Archived');
	const del = (ids: number[]) => act('delete', ids, {}, ids.length > 1 ? `${ids.length} deleted` : 'Deleted');
	const spam = (ids: number[]) => act('spam', ids, {}, 'Marked as spam');
	const moveTo = (ids: number[], folderId: number) => { moveMenuOpen = false; void act('move', ids, { folderId }, 'Moved'); };

	async function setFlag(ids: number[], flag: 'seen' | 'flagged', value: boolean) {
		if (ids.length === 0) return;
		messages = messages.map((m) => ids.includes(m.id) ? { ...m, [flag === 'seen' ? 'seen' : 'flagged']: value } : m);
		try {
			await apiPost('/api/mail', { action: 'flag', ids, flag, value });
			void invalidateAll();
		} catch { void loadList(); }
	}

	function toggleStar(m: ListMessage) {
		void setFlag([m.id], 'flagged', !m.flagged);
	}

	// ---------- snooze ----------
	function snoozePresets(): { label: string; when: Date }[] {
		const now = new Date();
		const later = new Date(now);
		later.setHours(now.getHours() + 3, 0, 0, 0);
		const eve = new Date(now); eve.setHours(18, 0, 0, 0);
		const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
		const weekend = new Date(now); weekend.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7)); weekend.setHours(9, 0, 0, 0);
		const nextWeek = new Date(now); nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); nextWeek.setHours(9, 0, 0, 0);
		const out = [{ label: 'Later today', when: later.getTime() > now.getTime() ? later : eve }];
		if (eve.getTime() > now.getTime() && eve.getTime() !== out[0].when.getTime()) out.push({ label: 'This evening', when: eve });
		out.push({ label: 'Tomorrow morning', when: tomorrow }, { label: 'This weekend', when: weekend }, { label: 'Next week', when: nextWeek });
		return out;
	}

	function snooze(ids: number[], until: Date) {
		snoozeMenuFor = null;
		void act('snooze', ids, { until: until.getTime() }, `Snoozed until ${until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
	}

	function unsnooze(ids: number[]) {
		void act('unsnooze', ids, {}, 'Returned to inbox');
	}

	// ---------- search ----------
	function onSearchInput() {
		if (searchTimer) clearTimeout(searchTimer);
		const q = searchQ.trim();
		if (!q) { searchActive = false; searchResults = []; return; }
		searchTimer = setTimeout(() => void runSearch(q), 220);
	}

	async function runSearch(q: string) {
		searchActive = true;
		searchBusy = true;
		try {
			const local = await apiGet<{ local: (ListMessage & { source: string })[] }>(`/api/search?profile=${data.profile.id}&q=${encodeURIComponent(q)}`);
			searchResults = local.local;
			// server-side pass in parallel-ish (second request includes IMAP SEARCH)
			const full = await apiGet<{ local: (ListMessage & { source: string })[]; server: (ListMessage & { source: string })[] }>(`/api/search?profile=${data.profile.id}&q=${encodeURIComponent(q)}&server=1`);
			const seen = new Set(full.local.map((m) => m.id));
			searchResults = [...full.local, ...full.server.filter((m) => !seen.has(m.id))];
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Search failed');
		} finally {
			searchBusy = false;
		}
	}

	function clearSearch() {
		searchQ = '';
		searchActive = false;
		searchResults = [];
	}

	// ---------- compose ----------
	function openComposer(prefill: ComposerPrefill) {
		if (identities.length === 0) {
			toasts.error('Connect a mail account first to compose.');
			return;
		}
		composers = [...composers, { key: ++composerKey, prefill }];
	}

	async function replyTo(mode: 'reply' | 'replyAll' | 'forward') {
		if (!detail) return;
		try {
			const prefill = await apiPut<ComposerPrefill>('/api/mail', { messageId: detail.message.id, mode });
			openComposer({ ...prefill, mode });
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not prepare reply');
		}
	}

	// ---------- email → task ----------
	async function makeTask() {
		const m = detail?.message ?? displayed.find((x) => x.id === selectedId);
		if (!m) return;
		try {
			const lists = await apiGet<{ lists: { id: number }[] }>(`/api/tasks?profile=${data.profile.id}&view=lists`);
			if (lists.lists.length === 0) { toasts.error('No task list connected. Add a CalDAV account first.'); return; }
			await apiPost('/api/tasks', {
				action: 'create',
				calendarId: lists.lists[0].id,
				summary: m.subject || 'Follow up',
				description: `From: ${m.from[0]?.name || m.from[0]?.address || 'unknown'}\nOpen in Slate: /mail?message=${m.id}`
			});
			toasts.success('Task created');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not create task');
		}
	}

	// ---------- triage mode ----------
	function startTriage() {
		triageQueue = messages.filter((m) => !m.seen);
		if (triageQueue.length === 0) { toasts.show('No unread mail — inbox is calm 🍃'); return; }
		triageMode = true;
		void openMessage(triageQueue[0]);
	}

	// ---------- keyboard ----------
	function moveSelection(delta: number) {
		const list = displayed;
		if (list.length === 0) return;
		const idx = selectedId === null ? -1 : list.findIndex((m) => m.id === selectedId);
		const next = Math.max(0, Math.min(list.length - 1, idx + delta));
		const m = list[next];
		if (m && m.id !== selectedId) {
			selectedId = m.id;
			listEl?.scrollToIndex(next);
			if (paneMode !== 'off' && window.innerWidth > 900) void openMessage(m);
		}
	}

	$effect(() => {
		if (!data.settings.shortcutsEnabled) return;
		const offs = [
			shortcuts.register('j', () => moveSelection(1)),
			shortcuts.register('k', () => moveSelection(-1)),
			shortcuts.register('o', openSelected),
			shortcuts.register('enter', openSelected),
			shortcuts.register('u', () => closeReading()),
			shortcuts.register('e', () => void archive(actionTargets)),
			shortcuts.register('#', () => void del(actionTargets)),
			shortcuts.register('!', () => void spam(actionTargets)),
			shortcuts.register('r', () => void replyTo('reply')),
			shortcuts.register('a', () => void replyTo('replyAll')),
			shortcuts.register('f', () => void replyTo('forward')),
			shortcuts.register('c', () => openComposer({ mode: 'new' })),
			shortcuts.register('s', () => { const m = displayed.find((x) => x.id === selectedId); if (m) toggleStar(m); }),
			shortcuts.register('b', () => { if (actionTargets.length) snoozeMenuFor = actionTargets; }),
			shortcuts.register('t', () => void makeTask()),
			shortcuts.register('x', () => { const m = displayed.find((x) => x.id === selectedId) ?? displayed[0]; if (m) toggleCheck(m, false); }),
			shortcuts.register('shift+i', () => void setFlag(actionTargets, 'seen', true)),
			shortcuts.register('shift+u', () => void setFlag(actionTargets, 'seen', false)),
			shortcuts.register('/', () => { searchInputEl?.focus(); }),
			shortcuts.register('escape', () => {
				if (snoozeMenuFor) snoozeMenuFor = null;
				else if (moveMenuOpen) moveMenuOpen = false;
				else if (splitEditorOpen) splitEditorOpen = false;
				else if (searchActive) clearSearch();
				else if (checkedIds.size > 0) checkedIds = new Set();
				else if (triageMode) { triageMode = false; closeReading(); }
				else closeReading();
			})
		];
		return () => offs.forEach((f) => f());
	});

	function openSelected() {
		const m = displayed.find((x) => x.id === selectedId) ?? displayed[0];
		if (m) void openMessage(m);
	}

	// ---------- split editor ----------
	let editSplits = $state<{ id?: number; name: string; rules: { field: string; value: string }[] }[]>([]);

	function openSplitEditor() {
		editSplits = splits.map((s) => ({ id: s.id, name: s.name, rules: JSON.parse(s.rules_json) }));
		if (editSplits.length === 0) {
			editSplits = [
				{ name: 'Newsletters', rules: [{ field: 'list', value: '*' }] },
				{ name: 'Starred', rules: [{ field: 'starred', value: '' }] }
			];
		}
		splitEditorOpen = true;
	}

	async function saveSplits() {
		try {
			await apiPost('/api/mail', {
				action: 'save-splits',
				profileId: data.profile.id,
				splits: editSplits.filter((s) => s.name.trim()).map((s, i) => ({ name: s.name.trim(), rules: s.rules.filter((r) => r.field === 'has-attachment' || r.field === 'starred' || r.value.trim()), sortOrder: i }))
			});
			splitEditorOpen = false;
			await loadSplits();
			void loadList();
			toasts.success('Inbox tabs saved');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}

	const badConnection = $derived(connections.find((c) => c.status === 'error'));
	const paneRight = $derived(paneMode === 'right');
	const paneBottom = $derived(paneMode === 'bottom');
	const paneOff = $derived(paneMode === 'off');
</script>

<svelte:head><title>{viewTitle} — Slate</title></svelte:head>

<div class="mail-page" class:pane-bottom={paneBottom} class:mobile-reading={mobileReading}>
	<!-- ============ list column ============ -->
	<section class="list-col" style={paneRight && !paneOff ? `width:${listWidth}px` : ''} aria-label="Message list">
		<header class="list-head">
			<div class="search-wrap">
				<svg class="search-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>
				<input
					bind:this={searchInputEl}
					class="search-input"
					type="search"
					placeholder="Search mail  (from: to: subject: is:unread has:attachment before: after:)"
					bind:value={searchQ}
					oninput={onSearchInput}
					onkeydown={(e) => { if (e.key === 'Escape') { clearSearch(); (e.target as HTMLInputElement).blur(); } }}
					aria-label="Search mail"
				/>
				{#if searchQ}
					<button class="search-clear" onclick={clearSearch} aria-label="Clear search">✕</button>
				{/if}
			</div>
		</header>

		<div class="list-title-row">
			<h1 class="list-title">{searchActive ? 'Search' : viewTitle}</h1>
			{#if searchBusy}<span class="spin" aria-label="Searching"></span>{/if}
			<span class="grow"></span>
			{#if isInbox && !searchActive}
				{#if inboxes.length > 1}
					<button class="mini-btn" class:on={unifiedView} title="Unified inbox"
						onclick={() => goto(unifiedView ? `/mail?folder=${inboxes[0].id}` : '/mail?unified=1')}>
						{unifiedView ? '⊞ Unified' : '⊟ Unify'}
					</button>
				{/if}
				<button class="mini-btn" onclick={startTriage} title="Triage unread one by one">⚡ Triage</button>
			{/if}
			{#if currentFolder && !searchActive}
				<button class="mini-btn" title="Refresh folder" onclick={async () => {
					try { await apiPost('/api/mail', { action: 'sync-folder', accountId: currentFolder!.account_id, folderId: currentFolder!.id }); void loadList(); void invalidateAll(); }
					catch (e) { toasts.error(e instanceof Error ? e.message : 'Sync failed'); }
				}}>↻</button>
			{/if}
		</div>

		{#if badConnection}
			<div class="conn-warn" role="alert">
				⚠ Connection problem{badConnection.error ? `: ${badConnection.error}` : ''}.
				<a href="/settings/accounts">Check account</a>
			</div>
		{/if}

		{#if isInbox && splits.length > 0 && !searchActive}
			<div class="split-tabs" role="tablist" aria-label="Inbox tabs">
				<button role="tab" aria-selected={activeSplit === 'all'} class:on={activeSplit === 'all'} onclick={() => (activeSplit = 'all')}>All</button>
				{#each splits as s (s.id)}
					<button role="tab" aria-selected={activeSplit === String(s.id)} class:on={activeSplit === String(s.id)} onclick={() => (activeSplit = String(s.id))}>{s.name}</button>
				{/each}
				<button role="tab" aria-selected={activeSplit === 'other'} class:on={activeSplit === 'other'} onclick={() => (activeSplit = 'other')}>Other</button>
				<button class="tab-edit" title="Edit inbox tabs" onclick={openSplitEditor} aria-label="Edit inbox tabs">⚙</button>
			</div>
		{:else if isInbox && !searchActive}
			<div class="split-tabs">
				<button class="tab-edit standalone" onclick={openSplitEditor}>+ Add inbox tabs</button>
			</div>
		{/if}

		{#if checkedIds.size > 0}
			<div class="bulk-bar glass" role="toolbar" aria-label="Bulk actions">
				<button class="mini-btn" onclick={selectAll}>{checkedIds.size === displayed.length ? 'None' : 'All'}</button>
				<span class="bulk-count tnum">{checkedIds.size} selected</span>
				<span class="grow"></span>
				<button class="mini-btn" title="Archive (e)" onclick={() => void archive([...checkedIds])}>📥</button>
				<button class="mini-btn" title="Delete (#)" onclick={() => void del([...checkedIds])}>🗑</button>
				<button class="mini-btn" title="Mark read" onclick={() => void setFlag([...checkedIds], 'seen', true)}>◎</button>
				<button class="mini-btn" title="Mark unread" onclick={() => void setFlag([...checkedIds], 'seen', false)}>●</button>
				<button class="mini-btn" title="Snooze (b)" onclick={() => (snoozeMenuFor = [...checkedIds])}>⏰</button>
				<button class="mini-btn" title="Spam (!)" onclick={() => void spam([...checkedIds])}>⚠</button>
				<div class="move-wrap">
					<button class="mini-btn" title="Move to folder" onclick={() => (moveMenuOpen = !moveMenuOpen)}>📁</button>
					{#if moveMenuOpen}
						<div class="menu glass" role="menu">
							{#each data.folders.filter((f) => f.id !== currentFolder?.id) as f (f.id)}
								<button role="menuitem" onclick={() => moveTo([...checkedIds], f.id)}>{f.name}</button>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		{#if loading}
			<div class="skeletons" aria-hidden="true">
				{#each Array(8) as _, i (i)}
					<div class="skel-row"><div class="skeleton circ"></div><div class="skel-lines"><div class="skeleton l1"></div><div class="skeleton l2"></div></div></div>
				{/each}
			</div>
		{:else if listError}
			<div class="empty-state" role="alert">
				<div class="empty-art">⚠️</div>
				<p>{listError}</p>
				<button class="btn" onclick={() => void loadList()}>Retry</button>
			</div>
		{:else if displayed.length === 0}
			<div class="empty-state">
				{#if searchActive}
					<div class="empty-art">🔍</div>
					<p>No results for “{searchQ}”.</p>
				{:else if snoozedView}
					<div class="empty-art">🌙</div>
					<p>Nothing is snoozed.</p>
				{:else if isInbox}
					<div class="empty-art zen">🍃</div>
					<h2 class="empty-zero">Inbox zero</h2>
					<p>You're all caught up. Enjoy the quiet.</p>
				{:else}
					<div class="empty-art">📭</div>
					<p>This folder is empty.</p>
				{/if}
			</div>
		{:else}
			{#if searchActive}
				<div class="search-note">{searchResults.length} result{searchResults.length === 1 ? '' : 's'}{searchBusy ? ' · searching server…' : ''}</div>
			{/if}
			<MessageList
				bind:this={listEl}
				messages={displayed}
				{selectedId}
				{checkedIds}
				density={data.settings.density}
				timeFormat={data.settings.timeFormat}
				onopen={(m) => void openMessage(m)}
				oncheck={toggleCheck}
				onstar={toggleStar}
				onendreached={() => void loadMore()}
			/>
			{#if loadingMore}<div class="load-more-note">Loading older messages…</div>{/if}
		{/if}

		{#if snoozedView && checkedIds.size > 0}
			<div class="snoozed-actions">
				<button class="btn" onclick={() => unsnooze([...checkedIds])}>Return to inbox now</button>
			</div>
		{/if}
	</section>

	{#if paneRight && !paneOff}
		<div class="resizer" role="separator" aria-orientation="vertical" aria-label="Resize list" onpointerdown={startResize}></div>
	{/if}

	<!-- ============ reading pane ============ -->
	{#if !paneOff || mobileReading}
		<section class="read-col" aria-label="Reading pane">
			{#if detailLoading}
				<div class="read-skel">
					<div class="skeleton" style="width: 60%; height: 24px"></div>
					<div class="skeleton" style="width: 40%; height: 14px; margin-top: 12px"></div>
					<div class="skeleton" style="width: 100%; height: 300px; margin-top: 24px"></div>
				</div>
			{:else if detailError}
				<div class="empty-state" role="alert">
					<div class="empty-art">📡</div>
					<p>{detailError}</p>
					{#if selectedId}<button class="btn" onclick={() => void loadDetail(selectedId!)}>Retry</button>{/if}
				</div>
			{:else if detail}
				{#if triageMode}
					<div class="triage-bar glass">
						<span>⚡ Triage · {triageQueue.length} to go</span>
						<button class="mini-btn" onclick={() => { triageMode = false; }}>Exit</button>
					</div>
				{/if}
				{#if thread.length > 1}
					<div class="thread-strip" role="list" aria-label="Conversation">
						{#each thread as tm (tm.id)}
							<button
								class="thread-item"
								class:cur={tm.id === detail.message.id}
								class:unseen={!tm.seen}
								role="listitem"
								onclick={() => void openById(tm.id)}
							>
								<span class="t-from trunc">{tm.from[0]?.name || tm.from[0]?.address}</span>
								<span class="t-date tnum">{fmtTime(tm.date, data.settings.timeFormat)}</span>
							</button>
						{/each}
					</div>
				{/if}
				<ReadingPane
					{detail}
					profileId={data.profile.id}
					isDarkTheme={isDark}
					timeFormat={data.settings.timeFormat}
					onreply={(mode) => void replyTo(mode)}
					onreload={(p) => void loadDetail(detail!.message.id, p)}
					onback={closeReading}
					onmaketask={() => void makeTask()}
				/>
				<div class="read-quickbar glass" role="toolbar" aria-label="Message actions">
					<button title="Archive (e)" onclick={() => void archive([detail!.message.id])}>📥</button>
					<button title="Delete (#)" onclick={() => void del([detail!.message.id])}>🗑</button>
					<button title="Snooze (b)" onclick={() => (snoozeMenuFor = [detail!.message.id])}>⏰</button>
					<button title="Reply (r)" onclick={() => void replyTo('reply')}>↩</button>
					<button title="Reply all (a)" onclick={() => void replyTo('replyAll')}>↩↩</button>
					<button title="Forward (f)" onclick={() => void replyTo('forward')}>➡</button>
					<button title="Make task (t)" onclick={() => void makeTask()}>✓</button>
				</div>
			{:else}
				<div class="empty-state subtle">
					<div class="empty-art">✉️</div>
					<p>Select a message to read</p>
					<p class="hint-row"><span class="kbd">j</span><span class="kbd">k</span> to move · <span class="kbd">Enter</span> to open</p>
				</div>
			{/if}
		</section>
	{/if}
</div>

<!-- ============ snooze menu ============ -->
{#if snoozeMenuFor}
	<div class="overlay" role="presentation" onclick={() => (snoozeMenuFor = null)} onkeydown={(e) => { if (e.key === 'Escape') snoozeMenuFor = null; }}>
		<div class="snooze-menu glass" role="dialog" aria-label="Snooze until" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
			<h3>Snooze until…</h3>
			{#each snoozePresets() as p (p.label)}
				<button class="snooze-opt" onclick={() => snooze(snoozeMenuFor!, p.when)}>
					<span>{p.label}</span>
					<span class="snooze-when tnum">{p.when.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>
				</button>
			{/each}
			<div class="snooze-custom">
				<input class="input" type="datetime-local" bind:value={customSnooze} aria-label="Custom snooze time" />
				<button class="btn btn-primary" disabled={!customSnooze} onclick={() => { const d = new Date(customSnooze); if (d.getTime() > Date.now()) snooze(snoozeMenuFor!, d); else toasts.error('Pick a future time'); }}>Snooze</button>
			</div>
		</div>
	</div>
{/if}

<!-- ============ split editor ============ -->
{#if splitEditorOpen}
	<div class="overlay" role="presentation" onclick={() => (splitEditorOpen = false)} onkeydown={(e) => { if (e.key === 'Escape') splitEditorOpen = false; }}>
		<div class="split-editor glass" role="dialog" aria-label="Edit inbox tabs" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
			<h3>Inbox tabs</h3>
			<p class="split-help">Messages matching a tab's rules appear under that tab; everything else lands in “Other”.</p>
			{#each editSplits as s, si (si)}
				<div class="split-row">
					<input class="input" type="text" bind:value={s.name} placeholder="Tab name" aria-label="Tab name" />
					<button class="mini-btn" onclick={() => (editSplits = editSplits.toSpliced(si, 1))} aria-label="Remove tab">✕</button>
					{#each s.rules as r, ri (ri)}
						<div class="rule-row">
							<select class="input" bind:value={r.field} aria-label="Rule type">
								<option value="sender">Sender contains</option>
								<option value="domain">Domain is</option>
								<option value="list">Mailing list (* = any)</option>
								<option value="subject">Subject contains</option>
								<option value="has-attachment">Has attachment</option>
								<option value="starred">Starred</option>
							</select>
							{#if r.field !== 'has-attachment' && r.field !== 'starred'}
								<input class="input" type="text" bind:value={r.value} placeholder="Value" aria-label="Rule value" />
							{/if}
							<button class="mini-btn" onclick={() => (s.rules = s.rules.toSpliced(ri, 1))} aria-label="Remove rule">−</button>
						</div>
					{/each}
					<button class="mini-btn add-rule" onclick={() => (s.rules = [...s.rules, { field: 'sender', value: '' }])}>+ rule</button>
				</div>
			{/each}
			<button class="btn" onclick={() => (editSplits = [...editSplits, { name: '', rules: [{ field: 'sender', value: '' }] }])}>+ Add tab</button>
			<footer>
				<button class="btn btn-ghost" onclick={() => (splitEditorOpen = false)}>Cancel</button>
				<button class="btn btn-primary" onclick={() => void saveSplits()}>Save</button>
			</footer>
		</div>
	</div>
{/if}

<!-- ============ composers ============ -->
{#each composers as c (c.key)}
	<Composer
		profileId={data.profile.id}
		{identities}
		prefill={c.prefill}
		undoSendSeconds={data.settings.undoSendSeconds}
		onclose={() => (composers = composers.filter((x) => x.key !== c.key))}
	/>
{/each}

<style>
	.mail-page {
		display: flex;
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}
	.mail-page.pane-bottom { flex-direction: column; }
	.list-col {
		display: flex; flex-direction: column;
		min-width: 0; min-height: 0;
		flex: 1;
		border-right: 1px solid var(--border);
	}
	.pane-bottom .list-col { border-right: none; border-bottom: 1px solid var(--border); flex: 1; }
	.mail-page:not(.pane-bottom) .list-col { flex: none; }
	.mail-page:not(.pane-bottom) .list-col:last-child { flex: 1; border-right: none; }
	.read-col {
		flex: 1; min-width: 0; min-height: 0;
		display: flex; flex-direction: column;
		position: relative;
		overflow-y: auto;
	}
	.pane-bottom .read-col { flex: 1; }
	.resizer {
		width: 5px; cursor: col-resize; flex: none;
		background: transparent;
		transition: background var(--dur-1);
	}
	.resizer:hover { background: color-mix(in oklab, var(--accent) 30%, transparent); }

	.list-head { padding: 12px 14px 6px; }
	.search-wrap { position: relative; display: flex; align-items: center; }
	.search-ico { position: absolute; left: 11px; color: var(--text-3); pointer-events: none; }
	.search-input {
		width: 100%;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--r-2);
		padding: 8px 32px 8px 32px;
		color: var(--text-1); font-family: inherit; font-size: 13px;
		outline: none;
		transition: border-color var(--dur-1), background var(--dur-1);
	}
	.search-input:focus { border-color: var(--accent); background: var(--surface-1); }
	.search-clear { position: absolute; right: 8px; background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 12px; }
	.list-title-row { display: flex; align-items: center; gap: 8px; padding: 4px 14px 8px; }
	.list-title { font-family: var(--font-display); font-size: 19px; font-weight: 640; margin: 0; }
	.grow { flex: 1; }
	.mini-btn {
		background: none; border: 1px solid transparent;
		color: var(--text-2); font-family: inherit; font-size: 12.5px;
		padding: 4px 8px; border-radius: var(--r-1); cursor: pointer;
		transition: background var(--dur-1);
	}
	.mini-btn:hover { background: var(--surface-2); color: var(--text-1); }
	.mini-btn.on { background: color-mix(in oklab, var(--accent) 15%, transparent); color: var(--accent); }
	.spin {
		width: 12px; height: 12px; border-radius: 50%;
		border: 2px solid var(--border); border-top-color: var(--accent);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	.conn-warn {
		margin: 0 14px 8px;
		padding: 8px 12px;
		background: color-mix(in oklab, var(--warn) 14%, var(--surface-1));
		border: 1px solid color-mix(in oklab, var(--warn) 40%, transparent);
		border-radius: var(--r-2);
		font-size: 12.5px;
	}
	.conn-warn a { color: var(--accent); }

	.split-tabs {
		display: flex; gap: 2px; align-items: center;
		padding: 0 14px 8px;
		overflow-x: auto;
	}
	.split-tabs [role='tab'] {
		background: none; border: none; cursor: pointer;
		font-family: inherit; font-size: 13px; color: var(--text-3);
		padding: 6px 12px; border-radius: 99px;
		transition: all var(--dur-1);
		white-space: nowrap;
	}
	.split-tabs [role='tab']:hover { color: var(--text-1); background: var(--surface-2); }
	.split-tabs [role='tab'].on { background: color-mix(in oklab, var(--accent) 16%, transparent); color: var(--accent); font-weight: 600; }
	.tab-edit { background: none; border: none; color: var(--text-3); cursor: pointer; padding: 4px 8px; font-size: 12px; border-radius: var(--r-1); font-family: inherit; }
	.tab-edit:hover { background: var(--surface-2); color: var(--text-1); }
	.tab-edit.standalone { font-size: 12.5px; }

	.bulk-bar {
		display: flex; align-items: center; gap: 4px;
		margin: 0 14px 8px;
		padding: 6px 10px;
		border-radius: var(--r-2);
		animation: bulk-in var(--dur-1) var(--ease-spring);
	}
	@keyframes bulk-in { from { opacity: 0; transform: translateY(-6px); } }
	.bulk-count { font-size: 12.5px; color: var(--text-2); }
	.move-wrap { position: relative; }
	.menu {
		position: absolute; right: 0; top: 100%; z-index: 50;
		min-width: 180px; max-height: 300px; overflow-y: auto;
		border-radius: var(--r-2); padding: 4px;
		box-shadow: var(--shadow-3);
	}
	.menu button {
		display: block; width: 100%; text-align: left;
		background: none; border: none; cursor: pointer;
		font-family: inherit; font-size: 13px; color: var(--text-1);
		padding: 7px 10px; border-radius: var(--r-1);
	}
	.menu button:hover { background: color-mix(in oklab, var(--accent) 13%, transparent); }

	.skeletons { padding: 4px 14px; }
	.skel-row { display: flex; gap: 10px; padding: 12px 0; align-items: center; }
	.circ { width: 36px; height: 36px; border-radius: 50%; flex: none; }
	.skel-lines { flex: 1; }
	.l1 { height: 13px; width: 55%; border-radius: 6px; }
	.l2 { height: 11px; width: 85%; border-radius: 6px; margin-top: 7px; }

	.empty-state {
		flex: 1; display: flex; flex-direction: column;
		align-items: center; justify-content: center;
		gap: 8px; padding: 40px 24px; text-align: center;
		color: var(--text-3); font-size: 14px;
	}
	.empty-art { font-size: 40px; opacity: 0.85; }
	.empty-art.zen { animation: float 4s ease-in-out infinite; }
	@keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
	.empty-zero { font-family: var(--font-display); font-size: 26px; color: var(--text-1); margin: 0; }
	.hint-row { display: flex; gap: 6px; align-items: center; font-size: 12px; }
	.search-note { padding: 2px 14px 6px; font-size: 12px; color: var(--text-3); }
	.load-more-note { padding: 10px; text-align: center; font-size: 12.5px; color: var(--text-3); }
	.snoozed-actions { padding: 10px 14px; border-top: 1px solid var(--border); }

	.read-skel { padding: 32px; }
	.triage-bar {
		display: flex; align-items: center; justify-content: space-between;
		margin: 10px 14px 0; padding: 8px 14px;
		border-radius: var(--r-2); font-size: 13px; font-weight: 600;
	}
	.thread-strip {
		display: flex; flex-direction: column;
		margin: 10px 14px 0;
		border: 1px solid var(--border); border-radius: var(--r-2);
		overflow: hidden;
		max-height: 180px; overflow-y: auto;
		flex: none;
	}
	.thread-item {
		display: flex; justify-content: space-between; gap: 12px;
		background: var(--surface-1);
		border: none; border-bottom: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
		padding: 8px 12px; cursor: pointer;
		font-family: inherit; font-size: 12.5px; color: var(--text-2);
		text-align: left;
	}
	.thread-item:last-child { border-bottom: none; }
	.thread-item:hover { background: var(--surface-2); }
	.thread-item.cur { background: color-mix(in oklab, var(--accent) 10%, var(--surface-1)); color: var(--text-1); font-weight: 600; }
	.thread-item.unseen { color: var(--text-1); font-weight: 650; }
	.t-from { min-width: 0; }
	.t-date { flex: none; color: var(--text-3); }

	.read-quickbar {
		position: sticky; bottom: 14px;
		margin: 10px auto 14px;
		display: flex; gap: 2px;
		padding: 5px;
		border-radius: 99px;
		box-shadow: var(--shadow-2);
		width: fit-content;
	}
	.read-quickbar button {
		background: none; border: none; cursor: pointer;
		font-size: 14px; width: 34px; height: 34px;
		border-radius: 50%;
		transition: background var(--dur-1), transform var(--dur-1);
	}
	.read-quickbar button:hover { background: var(--surface-2); transform: translateY(-1px); }

	.overlay {
		position: fixed; inset: 0; z-index: 900;
		background: color-mix(in oklab, var(--bg) 45%, transparent);
		backdrop-filter: blur(2px);
		display: grid; place-items: center;
	}
	.snooze-menu, .split-editor {
		border-radius: var(--r-3);
		box-shadow: var(--shadow-3);
		padding: 18px;
		width: min(400px, calc(100vw - 32px));
		animation: pop-in var(--dur-2) var(--ease-spring);
		max-height: 85vh; overflow-y: auto;
	}
	@keyframes pop-in { from { opacity: 0; transform: scale(0.96) translateY(8px); } }
	.snooze-menu h3, .split-editor h3 { font-family: var(--font-display); margin: 0 0 12px; font-size: 17px; }
	.snooze-opt {
		display: flex; justify-content: space-between; align-items: baseline;
		width: 100%; background: none;
		border: none; cursor: pointer;
		font-family: inherit; font-size: 14px; color: var(--text-1);
		padding: 10px 12px; border-radius: var(--r-2);
	}
	.snooze-opt:hover { background: color-mix(in oklab, var(--accent) 13%, transparent); }
	.snooze-when { color: var(--text-3); font-size: 12px; }
	.snooze-custom { display: flex; gap: 8px; margin-top: 10px; padding-top: 12px; border-top: 1px solid var(--border); }
	.snooze-custom input { flex: 1; }

	.split-editor { width: min(520px, calc(100vw - 32px)); }
	.split-help { font-size: 12.5px; color: var(--text-3); margin: 0 0 14px; }
	.split-row {
		display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
		padding: 10px; margin-bottom: 10px;
		border: 1px solid var(--border); border-radius: var(--r-2);
		background: var(--surface-1);
	}
	.split-row > input { flex: 1; min-width: 120px; }
	.rule-row { display: flex; gap: 6px; width: 100%; align-items: center; }
	.rule-row select { flex: none; width: 170px; }
	.rule-row input { flex: 1; min-width: 80px; }
	.add-rule { font-size: 12px; }
	.split-editor footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	@media (max-width: 900px) {
		.mail-page { position: relative; }
		.list-col { width: 100% !important; border-right: none; }
		.resizer { display: none; }
		.read-col {
			position: absolute; inset: 0; z-index: 10;
			background: var(--bg);
			display: none;
		}
		.mobile-reading .read-col { display: flex; }
		.mobile-reading .list-col { display: none; }
	}
	@media (prefers-reduced-motion: reduce) {
		.bulk-bar, .snooze-menu, .split-editor { animation: none; }
		.empty-art.zen { animation: none; }
	}
</style>
