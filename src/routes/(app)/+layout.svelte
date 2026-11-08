<script lang="ts">
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { LayoutData } from './$types';
	import { APP_NAME, THEMES } from '$lib/config';
	import { sse } from '$lib/client/sse.svelte';
	import { shortcuts } from '$lib/client/shortcuts.svelte';
	import { toasts } from '$lib/client/toasts.svelte';
	import { apiPost } from '$lib/client/api';
	import Toasts from '$lib/components/Toasts.svelte';
	import CommandPalette, { type PaletteCommand } from '$lib/components/CommandPalette.svelte';
	import ShortcutHelp from '$lib/components/ShortcutHelp.svelte';
	import TodayPanel from '$lib/components/TodayPanel.svelte';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	let paletteOpen = $state(false);
	let helpOpen = $state(false);
	let todayPanelOpen = $state(false);
	let profileMenuOpen = $state(false);
	let sidebarOpen = $state(false); // mobile
	let unreadByFolder = $state<Record<number, number>>({});
	let profileUnread = $state<Record<number, number>>({});

	$effect(() => {
		profileUnread = data.profileUnread as Record<number, number>;
	});

	// theme application: profile override wins over global setting
	$effect(() => {
		const theme = data.profile.theme || data.settings.theme;
		const accent = data.profile.accent_h ?? data.settings.accentH;
		applyTheme(theme, accent);
	});

	function applyTheme(theme: string, accentH: number) {
		const resolved = theme === 'system'
			? (matchMedia('(prefers-color-scheme: light)').matches ? 'paper-light' : 'zen-dark')
			: theme;
		document.documentElement.dataset.theme = resolved;
		document.documentElement.style.setProperty('--accent-h', String(accentH));
		document.cookie = `slate_theme=${theme}|${accentH}; path=/; max-age=31536000; samesite=lax`;
	}

	async function switchProfile(id: number) {
		if (id === data.profile.id) return;
		profileMenuOpen = false;
		await apiPost('/api/profiles', { action: 'switch', profileId: id });
		await invalidateAll();
	}

	const currentSection = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/mail')) return 'mail';
		if (p.startsWith('/calendar')) return 'calendar';
		if (p.startsWith('/tasks')) return 'tasks';
		if (p.startsWith('/contacts')) return 'contacts';
		if (p.startsWith('/settings')) return 'settings';
		return 'today';
	});

	// folders grouped per account, with role folders first
	const roleOrder: Record<string, number> = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 };
	const accountFolders = $derived.by(() => {
		const mailAccounts = data.accounts.filter((a) => a.kind === 'imap' || a.kind === 'pop3');
		return mailAccounts.map((acc) => {
			const all = data.folders.filter((f) => f.account_id === acc.id);
			const sorted = [...all].sort((a, b) => {
				const ra = a.role && roleOrder[a.role] !== undefined ? roleOrder[a.role] : 10;
				const rb = b.role && roleOrder[b.role] !== undefined ? roleOrder[b.role] : 10;
				if (ra !== rb) return ra - rb;
				return a.path.localeCompare(b.path);
			});
			return { account: acc, folders: sorted };
		});
	});

	function folderIcon(role: string | null): string {
		switch (role) {
			case 'inbox': return '📥';
			case 'sent': return '📤';
			case 'drafts': return '📝';
			case 'archive': return '🗂️';
			case 'trash': return '🗑️';
			case 'junk': return '🚫';
			default: return '📁';
		}
	}

	function folderUnread(f: { id: number; unseen: number }): number {
		return unreadByFolder[f.id] ?? f.unseen;
	}

	// SSE wiring
	onMount(() => {
		sse.start();
		const offs = [
			sse.on('badge', (ev) => {
				profileUnread = { ...profileUnread, ...(ev.counts as Record<number, number>) };
			}),
			sse.on('folders', (ev) => {
				if (ev.profileId === data.profile.id) void invalidateAll();
			}),
			sse.on('mail', (ev) => {
				const counts = ev.folderUnseen as Record<number, number> | undefined;
				if (counts) unreadByFolder = { ...unreadByFolder, ...counts };
			})
		];
		return () => {
			offs.forEach((off) => off());
		};
	});

	// global shortcuts
	onMount(() => {
		shortcuts.enabled = data.settings.shortcutsEnabled;
		window.addEventListener('keydown', shortcuts.handleKeydown);
		const un = [
			shortcuts.register('mod+k', () => { paletteOpen = !paletteOpen; }, { allowInInput: true }),
			shortcuts.register('?', () => { helpOpen = !helpOpen; }),
			shortcuts.register('mod+.', () => { todayPanelOpen = !todayPanelOpen; }, { allowInInput: true }),
			shortcuts.register('g i', () => goToFolderRole('inbox')),
			shortcuts.register('g s', () => goToFolderRole('sent')),
			shortcuts.register('g d', () => goToFolderRole('drafts')),
			shortcuts.register('g t', () => void goto('/today')),
			shortcuts.register('g c', () => void goto('/calendar')),
			shortcuts.register('z', () => { toasts.undoLatest(); }),
			...Array.from({ length: 9 }, (_, i) =>
				shortcuts.register(`mod+${i + 1}`, () => {
					const p = data.profiles[i];
					if (p) void switchProfile(p.id);
				}, { allowInInput: true })
			)
		];
		return () => {
			window.removeEventListener('keydown', shortcuts.handleKeydown);
			un.forEach((u) => u());
		};
	});

	function goToFolderRole(role: string) {
		const f = data.folders.find((x) => x.role === role);
		if (f) void goto(`/mail?folder=${f.id}`);
		else void goto('/mail');
	}

	// command palette commands
	const paletteCommands = $derived.by(() => {
		const cmds: PaletteCommand[] = [
			{ id: 'nav-today', label: 'Go to Today', group: 'Navigate', icon: '☀️', hint: 'g t', run: () => goto('/today') },
			{ id: 'nav-mail', label: 'Go to Mail', group: 'Navigate', icon: '✉️', hint: 'g i', run: () => goToFolderRole('inbox') },
			{ id: 'nav-cal', label: 'Go to Calendar', group: 'Navigate', icon: '📅', hint: 'g c', run: () => goto('/calendar') },
			{ id: 'nav-tasks', label: 'Go to Tasks', group: 'Navigate', icon: '✓', run: () => goto('/tasks') },
			{ id: 'nav-contacts', label: 'Go to Contacts', group: 'Navigate', icon: '👤', run: () => goto('/contacts') },
			{ id: 'nav-settings', label: 'Open Settings', group: 'Navigate', icon: '⚙️', run: () => goto('/settings') },
			{ id: 'compose', label: 'Compose new message', group: 'Actions', icon: '✏️', hint: 'c', run: () => goto('/mail?compose=new') },
			{ id: 'new-event', label: 'Create event', group: 'Actions', icon: '📅', run: () => goto('/calendar?new=1') },
			{ id: 'new-task', label: 'Create task', group: 'Actions', icon: '✓', run: () => goto('/tasks?new=1') },
			{ id: 'toggle-today-panel', label: 'Toggle Today panel', group: 'Actions', icon: '🗓', hint: '⌘ .', run: () => { todayPanelOpen = !todayPanelOpen; } },
			{ id: 'help', label: 'Keyboard shortcuts', group: 'Actions', icon: '⌨️', hint: '?', run: () => { helpOpen = true; } }
		];
		for (const p of data.profiles) {
			if (p.id !== data.profile.id) {
				cmds.push({ id: `profile-${p.id}`, label: `Switch to ${p.name}`, group: 'Profiles', icon: p.icon, keywords: 'profile switch', run: () => switchProfile(p.id) });
			}
		}
		for (const t of THEMES) {
			cmds.push({
				id: `theme-${t.id}`, label: `Theme: ${t.name}`, group: 'Appearance', icon: '🎨', keywords: 'theme switch appearance',
				run: async () => {
					applyTheme(t.id, data.profile.accent_h ?? data.settings.accentH);
					await apiPost('/api/settings', { action: 'set', settings: { theme: t.id } });
				}
			});
		}
		for (const group of accountFolders) {
			for (const f of group.folders) {
				cmds.push({ id: `folder-${f.id}`, label: `Folder: ${f.name}${accountFolders.length > 1 ? ` (${group.account.name})` : ''}`, group: 'Folders', icon: folderIcon(f.role), keywords: 'folder jump', run: () => goto(`/mail?folder=${f.id}`) });
			}
		}
		return cmds;
	});

	const totalInboxUnread = $derived(
		data.folders.filter((f) => f.role === 'inbox').reduce((sum, f) => sum + folderUnread(f), 0)
	);
</script>

<svelte:head><title>{APP_NAME}</title></svelte:head>

<div class="app-shell density-{data.settings.density}">
	<button class="mobile-nav-toggle btn btn-ghost" onclick={() => (sidebarOpen = !sidebarOpen)} aria-label="Toggle navigation">☰</button>

	<nav class="sidebar" class:open={sidebarOpen} aria-label="Main navigation">
		<!-- profile switcher -->
		<div class="profile-area">
			<button
				class="profile-btn"
				onclick={() => (profileMenuOpen = !profileMenuOpen)}
				aria-expanded={profileMenuOpen}
				aria-haspopup="menu"
				style="--p-accent: {data.profile.accent_h != null ? `oklch(0.72 0.14 ${data.profile.accent_h})` : 'var(--accent)'}"
			>
				<span class="profile-icon">{data.profile.icon}</span>
				<span class="profile-name">{data.profile.name}</span>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
			</button>
			{#if profileMenuOpen}
				<div class="profile-menu glass" role="menu">
					{#each data.profiles as p, i (p.id)}
						<button class="profile-item" class:current={p.id === data.profile.id} role="menuitem" onclick={() => switchProfile(p.id)}>
							<span class="profile-icon-sm" style="--p-accent: {p.accent_h != null ? `oklch(0.72 0.14 ${p.accent_h})` : 'var(--accent)'}">{p.icon}</span>
							<span class="grow">{p.name}</span>
							{#if p.id !== data.profile.id && profileUnread[p.id]}
								<span class="badge tnum">{profileUnread[p.id]}</span>
							{/if}
							{#if i < 9}<kbd class="kbd">⌘{i + 1}</kbd>{/if}
						</button>
					{/each}
					<div class="menu-sep"></div>
					<button class="profile-item" role="menuitem" onclick={() => { profileMenuOpen = false; void goto('/settings/profiles'); }}>
						<span class="profile-icon-sm">＋</span> Manage profiles
					</button>
				</div>
			{/if}
		</div>

		<!-- primary nav -->
		<div class="nav-group">
			<a href="/today" class="nav-item" class:active={currentSection === 'today'} onclick={() => (sidebarOpen = false)}>
				<span class="nav-icon">☀️</span> Today
			</a>
			<a href="/mail" class="nav-item" class:active={currentSection === 'mail'} onclick={() => (sidebarOpen = false)}>
				<span class="nav-icon">✉️</span> Mail
				{#if totalInboxUnread > 0}<span class="badge tnum">{totalInboxUnread}</span>{/if}
			</a>
			<a href="/calendar" class="nav-item" class:active={currentSection === 'calendar'} onclick={() => (sidebarOpen = false)}>
				<span class="nav-icon">📅</span> Calendar
			</a>
			<a href="/tasks" class="nav-item" class:active={currentSection === 'tasks'} onclick={() => (sidebarOpen = false)}>
				<span class="nav-icon">✓</span> Tasks
			</a>
			<a href="/contacts" class="nav-item" class:active={currentSection === 'contacts'} onclick={() => (sidebarOpen = false)}>
				<span class="nav-icon">👤</span> Contacts
			</a>
		</div>

		<!-- folders -->
		<div class="folders">
			{#each accountFolders as group (group.account.id)}
				{#if accountFolders.length > 1}
					<div class="account-label">{group.account.name}</div>
				{/if}
				{#each group.folders as f (f.id)}
					<a
						href="/mail?folder={f.id}"
						class="nav-item folder"
						class:active={page.url.searchParams.get('folder') === String(f.id)}
						style="padding-left: {14 + (f.parent_path ? (f.path.split(f.delimiter || '/').length - 1) * 14 : 0)}px"
						onclick={() => (sidebarOpen = false)}
					>
						<span class="nav-icon">{folderIcon(f.role)}</span>
						<span class="grow trunc">{f.name}</span>
						{#if folderUnread(f) > 0 && f.role !== 'trash' && f.role !== 'junk'}
							<span class="badge tnum">{folderUnread(f)}</span>
						{/if}
					</a>
				{/each}
			{/each}
			{#if data.snoozedCount > 0}
				<a href="/mail?view=snoozed" class="nav-item folder" class:active={page.url.searchParams.get('view') === 'snoozed'} onclick={() => (sidebarOpen = false)}>
					<span class="nav-icon">⏰</span>
					<span class="grow">Snoozed</span>
					<span class="badge tnum">{data.snoozedCount}</span>
				</a>
			{/if}
			{#if accountFolders.length === 0}
				<a href="/settings/accounts" class="nav-item folder add-account" onclick={() => (sidebarOpen = false)}>
					<span class="nav-icon">＋</span> Add an account
				</a>
			{/if}
		</div>

		<!-- footer -->
		<div class="sidebar-foot">
			<span class="conn" class:ok={sse.connected} title={sse.connected ? 'Live updates connected' : 'Reconnecting…'} aria-label={sse.connected ? 'Connected' : 'Reconnecting'}></span>
			<a href="/settings" class="nav-item grow" class:active={currentSection === 'settings'}>
				<span class="nav-icon">⚙️</span> Settings
			</a>
		</div>
	</nav>

	{#if sidebarOpen}
		<button class="sidebar-scrim" onclick={() => (sidebarOpen = false)} aria-label="Close navigation"></button>
	{/if}

	<main class="main">
		{@render children()}
	</main>

	{#if todayPanelOpen && currentSection !== 'today'}
		<TodayPanel profileId={data.profile.id} />
	{/if}
</div>

<CommandPalette bind:open={paletteOpen} commands={paletteCommands} profileId={data.profile.id} onclose={() => {}} />
<ShortcutHelp bind:open={helpOpen} onclose={() => {}} />
<Toasts />

<style>
	.app-shell {
		display: flex;
		height: 100dvh;
		overflow: hidden;
		background: var(--bg);
	}
	.sidebar {
		width: 248px;
		flex: none;
		display: flex;
		flex-direction: column;
		background: var(--surface-0);
		border-right: 1px solid var(--border);
		padding: 12px 10px;
		overflow-y: auto;
		gap: 6px;
	}
	.profile-area { position: relative; margin-bottom: 4px; }
	.profile-btn {
		display: flex; align-items: center; gap: 10px;
		width: 100%; padding: 9px 10px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--r-3);
		cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 600;
		color: var(--text-1);
		transition: border-color var(--dur-1), background var(--dur-1);
	}
	.profile-btn:hover { border-color: color-mix(in oklab, var(--p-accent) 50%, var(--border)); }
	.profile-icon {
		width: 28px; height: 28px; display: grid; place-items: center;
		background: color-mix(in oklab, var(--p-accent) 18%, var(--surface-2));
		border-radius: var(--r-2); font-size: 15px;
	}
	.profile-name { flex: 1; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.profile-menu {
		position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 100;
		border-radius: var(--r-3); box-shadow: var(--shadow-3);
		padding: 5px;
		animation: menu-in var(--dur-1) var(--ease-spring) both;
	}
	.profile-item {
		display: flex; align-items: center; gap: 9px;
		width: 100%; padding: 8px 9px;
		background: none; border: none; border-radius: var(--r-2);
		cursor: pointer; font-family: inherit; font-size: 13.5px;
		color: var(--text-1); text-align: left;
	}
	.profile-item:hover { background: var(--surface-1); }
	.profile-item.current { background: color-mix(in oklab, var(--accent) 12%, transparent); }
	.profile-icon-sm {
		width: 24px; height: 24px; display: grid; place-items: center;
		background: color-mix(in oklab, var(--p-accent, var(--accent)) 18%, var(--surface-2));
		border-radius: 7px; font-size: 13px; flex: none;
	}
	.menu-sep { height: 1px; background: var(--border); margin: 4px 6px; }
	.nav-group { display: flex; flex-direction: column; gap: 1px; }
	.nav-item {
		display: flex; align-items: center; gap: 9px;
		padding: 7px 10px;
		border-radius: var(--r-2);
		color: var(--text-2); text-decoration: none;
		font-size: 13.5px; font-weight: 520;
		transition: background var(--dur-1), color var(--dur-1);
	}
	.nav-item:hover { background: var(--surface-1); color: var(--text-1); }
	.nav-item.active { background: color-mix(in oklab, var(--accent) 14%, transparent); color: var(--text-1); }
	.nav-icon { width: 20px; text-align: center; font-size: 13px; flex: none; }
	.grow { flex: 1; min-width: 0; }
	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.folders {
		flex: 1; overflow-y: auto;
		display: flex; flex-direction: column; gap: 1px;
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}
	.account-label {
		font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em;
		color: var(--text-3); padding: 10px 10px 4px; font-weight: 600;
	}
	.folder { font-size: 13px; }
	.add-account { color: var(--text-3); }
	.sidebar-foot {
		display: flex; align-items: center; gap: 8px;
		border-top: 1px solid var(--border); padding-top: 8px;
	}
	.conn {
		width: 8px; height: 8px; border-radius: 50%; flex: none; margin-left: 10px;
		background: var(--warn);
		transition: background var(--dur-2);
	}
	.conn.ok { background: var(--success); }
	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.mobile-nav-toggle { display: none; }
	.sidebar-scrim { display: none; }

	@keyframes menu-in { from { opacity: 0; transform: translateY(-6px) scale(0.98); } }

	@media (max-width: 860px) {
		.mobile-nav-toggle {
			display: grid; place-items: center;
			position: fixed; top: 10px; left: 10px; z-index: 300;
			width: 38px; height: 38px;
			background: var(--surface-1); border: 1px solid var(--border);
			border-radius: var(--r-2);
		}
		.sidebar {
			position: fixed; top: 0; bottom: 0; left: 0; z-index: 400;
			transform: translateX(-100%);
			transition: transform var(--dur-2) var(--ease-spring);
			box-shadow: var(--shadow-3);
		}
		.sidebar.open { transform: translateX(0); }
		.sidebar-scrim {
			display: block;
			position: fixed; inset: 0; z-index: 350;
			background: color-mix(in oklab, var(--bg) 55%, transparent);
			border: none; cursor: pointer;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sidebar { transition: none; }
		.profile-menu { animation: none; }
	}
</style>
