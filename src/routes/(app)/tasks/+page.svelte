<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { sse } from '$lib/client/sse.svelte';
	import { shortcuts } from '$lib/client/shortcuts.svelte';

	let { data } = $props();

	interface TaskList { id: number; name: string; color: string | null; account_name: string }
	interface Task {
		id: number; calendarId: number; uid: string;
		summary: string; description: string;
		due: number | null; start: number | null;
		completed: boolean; priority: number; parentUid: string | null;
		rrule: string | null; listName: string; color: string | null;
	}

	type ViewKey = 'today' | 'upcoming' | 'all' | 'completed' | `list-${number}`;
	let view = $state<ViewKey>('today');
	let lists = $state<TaskList[]>([]);
	let tasks = $state<Task[]>([]);
	let loading = $state(true);
	let quickText = $state('');
	let quickInputEl = $state<HTMLInputElement | null>(null);
	let selectedIdx = $state(-1);
	let editing = $state<Task | null>(null);
	let editDraft = $state({ summary: '', description: '', due: '', priority: 0 });

	async function load() {
		try {
			const [l, t] = await Promise.all([
				apiGet<{ lists: TaskList[] }>(`/api/tasks?profile=${data.profile.id}&view=lists`),
				apiGet<{ tasks: Task[] }>(`/api/tasks?profile=${data.profile.id}`)
			]);
			lists = l.lists;
			tasks = t.tasks;
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not load tasks');
		} finally {
			loading = false;
		}
	}

	$effect(() => { void data.profile.id; loading = true; void load(); });
	$effect(() => sse.on('tasks', () => void load()));

	const endOfToday = $derived.by(() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); });

	const filtered = $derived.by(() => {
		let out: Task[];
		if (view === 'today') out = tasks.filter((t) => !t.completed && t.due !== null && t.due <= endOfToday);
		else if (view === 'upcoming') out = tasks.filter((t) => !t.completed && t.due !== null && t.due > endOfToday);
		else if (view === 'all') out = tasks.filter((t) => !t.completed);
		else if (view === 'completed') out = tasks.filter((t) => t.completed);
		else out = tasks.filter((t) => t.calendarId === parseInt(view.slice(5), 10) && !t.completed);
		return out;
	});

	/** roots + subtask nesting via parentUid */
	const treed = $derived.by(() => {
		const byUid = new Map(filtered.map((t) => [t.uid, t]));
		const roots = filtered.filter((t) => !t.parentUid || !byUid.has(t.parentUid));
		const children = new Map<string, Task[]>();
		for (const t of filtered) {
			if (t.parentUid && byUid.has(t.parentUid)) {
				children.set(t.parentUid, [...(children.get(t.parentUid) ?? []), t]);
			}
		}
		const out: (Task & { depth: number })[] = [];
		const add = (t: Task, depth: number) => {
			out.push({ ...t, depth });
			for (const c of children.get(t.uid) ?? []) add(c, depth + 1);
		};
		for (const r of roots) add(r, 0);
		return out;
	});

	const countFor = (v: ViewKey): number => {
		if (v === 'today') return tasks.filter((t) => !t.completed && t.due !== null && t.due <= endOfToday).length;
		if (v === 'upcoming') return tasks.filter((t) => !t.completed && t.due !== null && t.due > endOfToday).length;
		if (v === 'all') return tasks.filter((t) => !t.completed).length;
		if (v === 'completed') return tasks.filter((t) => t.completed).length;
		return tasks.filter((t) => t.calendarId === parseInt(v.slice(5), 10) && !t.completed).length;
	};

	function dueLabel(t: Task): { text: string; overdue: boolean } {
		if (t.due === null) return { text: '', overdue: false };
		const d = new Date(t.due);
		const overdue = !t.completed && t.due < Date.now() && !isToday(d);
		if (isToday(d)) return { text: 'Today', overdue: !t.completed && t.due < Date.now() - 86400000 };
		const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
		if (d.toDateString() === tomorrow.toDateString()) return { text: 'Tomorrow', overdue };
		return { text: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), overdue };
	}
	function isToday(d: Date): boolean { return d.toDateString() === new Date().toDateString(); }

	async function toggle(t: Task) {
		const next = !t.completed;
		tasks = tasks.map((x) => (x.id === t.id ? { ...x, completed: next } : x));
		try {
			await apiPost('/api/tasks', { action: 'toggle', calendarId: t.calendarId, taskId: t.id, completed: next });
		} catch (e) {
			tasks = tasks.map((x) => (x.id === t.id ? { ...x, completed: !next } : x));
			toasts.error(e instanceof Error ? e.message : 'Could not update');
		}
	}

	async function quickAdd() {
		const text = quickText.trim();
		if (!text) return;
		const listId = view.startsWith('list-') ? parseInt(view.slice(5), 10) : lists[0]?.id;
		if (!listId) { toasts.error('No task list connected. Add a CalDAV account first.'); return; }
		quickText = '';
		try {
			const res = await apiPost<{ ok: boolean; error?: string }>('/api/tasks', { action: 'quick-add', calendarId: listId, text });
			if (!res.ok) { toasts.error(res.error ?? 'Could not add'); return; }
			void load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not add');
		}
	}

	async function del(t: Task) {
		tasks = tasks.filter((x) => x.id !== t.id);
		try {
			await apiPost('/api/tasks', { action: 'delete', calendarId: t.calendarId, taskId: t.id });
			toasts.show('Task deleted');
		} catch (e) {
			void load();
			toasts.error(e instanceof Error ? e.message : 'Could not delete');
		}
	}

	function openEdit(t: Task) {
		editing = t;
		editDraft = {
			summary: t.summary,
			description: t.description,
			due: t.due ? toLocalDate(t.due) : '',
			priority: t.priority
		};
	}

	function toLocalDate(ms: number): string {
		const d = new Date(ms);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

	async function saveEdit() {
		if (!editing) return;
		const t = editing;
		try {
			await apiPost('/api/tasks', {
				action: 'update',
				calendarId: t.calendarId, taskId: t.id,
				summary: editDraft.summary,
				description: editDraft.description,
				due: editDraft.due ? new Date(editDraft.due + 'T17:00').getTime() : null,
				priority: editDraft.priority,
				parentUid: t.parentUid
			});
			editing = null;
			void load();
			toasts.success('Task updated');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save');
		}
	}

	async function addSubtask(parent: Task) {
		const summary = prompt('Subtask title:');
		if (!summary?.trim()) return;
		try {
			await apiPost('/api/tasks', { action: 'create', calendarId: parent.calendarId, summary: summary.trim(), parentUid: parent.uid });
			void load();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not add subtask');
		}
	}

	function prioLabel(p: number): string {
		if (p >= 1 && p <= 4) return '!high';
		if (p === 5) return '!med';
		if (p > 5) return '!low';
		return '';
	}

	// keyboard
	$effect(() => {
		if (!data.settings.shortcutsEnabled) return;
		const offs = [
			shortcuts.register('n', () => quickInputEl?.focus()),
			shortcuts.register('j', () => { selectedIdx = Math.min(treed.length - 1, selectedIdx + 1); }),
			shortcuts.register('k', () => { selectedIdx = Math.max(0, selectedIdx - 1); }),
			shortcuts.register(' ', () => { const t = treed[selectedIdx]; if (t) void toggle(t); }),
			shortcuts.register('enter', () => { const t = treed[selectedIdx]; if (t) openEdit(t); }),
			shortcuts.register('#', () => { const t = treed[selectedIdx]; if (t) void del(t); })
		];
		return () => offs.forEach((f) => f());
	});

	const viewTitle = $derived.by(() => {
		if (view === 'today') return 'Today';
		if (view === 'upcoming') return 'Upcoming';
		if (view === 'all') return 'All tasks';
		if (view === 'completed') return 'Completed';
		return lists.find((l) => l.id === parseInt(view.slice(5), 10))?.name ?? 'Tasks';
	});
</script>

<svelte:head><title>Tasks — Slate</title></svelte:head>

<div class="tasks-page">
	<aside class="t-side" aria-label="Task views">
		{#each [['today', 'Today', '☀️'], ['upcoming', 'Upcoming', '📆'], ['all', 'All', '📋'], ['completed', 'Completed', '✅']] as [k, label, icon] (k)}
			<button class="t-nav" class:on={view === k} onclick={() => (view = k as ViewKey)}>
				<span class="t-ico">{icon}</span>{label}
				<span class="t-count tnum">{countFor(k as ViewKey) || ''}</span>
			</button>
		{/each}
		{#if lists.length > 0}
			<div class="t-sep">Lists</div>
			{#each lists as l (l.id)}
				<button class="t-nav" class:on={view === `list-${l.id}`} onclick={() => (view = `list-${l.id}` as ViewKey)}>
					<span class="t-dot" style="background: {l.color || 'var(--accent)'}"></span>
					<span class="trunc">{l.name}</span>
					<span class="t-count tnum">{countFor(`list-${l.id}` as ViewKey) || ''}</span>
				</button>
			{/each}
		{/if}
	</aside>

	<section class="t-main" aria-label="Tasks">
		<header class="t-head">
			<h1>{viewTitle}</h1>
			<span class="t-total tnum">{treed.length}</span>
		</header>

		<div class="quick-add">
			<input
				bind:this={quickInputEl}
				class="qa-input"
				type="text"
				placeholder='Add a task — try “pay rent friday !high”  (n)'
				bind:value={quickText}
				onkeydown={(e) => { if (e.key === 'Enter') void quickAdd(); }}
				aria-label="Quick add task"
			/>
			<button class="btn btn-primary" onclick={() => void quickAdd()} disabled={!quickText.trim()}>Add</button>
		</div>

		{#if loading}
			<div class="t-skels">
				{#each Array(5) as _, i (i)}<div class="skeleton t-skel"></div>{/each}
			</div>
		{:else if lists.length === 0}
			<div class="t-empty">
				<div class="empty-art">🗂</div>
				<p>No task lists yet.</p>
				<a class="btn" href="/settings/accounts">Connect a CalDAV account</a>
			</div>
		{:else if treed.length === 0}
			<div class="t-empty">
				<div class="empty-art">{view === 'completed' ? '🫙' : '🌿'}</div>
				<p>{view === 'completed' ? 'Nothing completed yet.' : view === 'today' ? 'Nothing due today. Breathe.' : 'No tasks here.'}</p>
			</div>
		{:else}
			<ul class="t-list" role="list">
				{#each treed as t, i (t.id)}
					{@const due = dueLabel(t)}
					<li class="t-row" class:done={t.completed} class:sel={i === selectedIdx} style="padding-left: {14 + t.depth * 26}px">
						<button class="t-check" class:on={t.completed} onclick={() => void toggle(t)} aria-label={t.completed ? 'Mark incomplete' : 'Complete task'}>
							{#if t.completed}✓{/if}
						</button>
						<button class="t-body" onclick={() => { selectedIdx = i; openEdit(t); }}>
							<span class="t-title">{t.summary || '(untitled)'}</span>
							{#if t.description}<span class="t-desc trunc">{t.description.split('\n')[0]}</span>{/if}
						</button>
						{#if t.priority > 0}
							<span class="t-prio" class:high={t.priority <= 4} class:med={t.priority === 5}>{prioLabel(t.priority)}</span>
						{/if}
						{#if t.rrule}<span class="t-recur" title="Repeats">↻</span>{/if}
						{#if due.text}<span class="t-due tnum" class:overdue={due.overdue}>{due.text}</span>{/if}
						{#if view === 'all' || view === 'today' || view === 'upcoming'}
							<span class="t-listtag trunc" style="--c: {t.color || 'var(--accent)'}">{t.listName}</span>
						{/if}
						<span class="t-acts">
							<button class="t-act" title="Add subtask" onclick={() => void addSubtask(t)}>＋</button>
							<button class="t-act" title="Delete (#)" onclick={() => void del(t)}>✕</button>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

{#if editing}
	<div class="overlay" role="presentation" onclick={() => (editing = null)} onkeydown={(e) => { if (e.key === 'Escape') editing = null; }}>
		<div class="edit glass" role="dialog" aria-label="Edit task" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
			<h3>Edit task</h3>
			<input class="input big" type="text" bind:value={editDraft.summary} placeholder="Task title" aria-label="Title" />
			<textarea class="input" rows="3" bind:value={editDraft.description} placeholder="Notes" aria-label="Notes"></textarea>
			<div class="edit-row">
				<label class="lbl">Due
					<input class="input" type="date" bind:value={editDraft.due} />
				</label>
				<label class="lbl">Priority
					<select class="input" bind:value={editDraft.priority}>
						<option value={0}>None</option>
						<option value={1}>High</option>
						<option value={5}>Medium</option>
						<option value={9}>Low</option>
					</select>
				</label>
			</div>
			<footer>
				<button class="btn btn-ghost" onclick={() => (editing = null)}>Cancel</button>
				<button class="btn btn-primary" onclick={() => void saveEdit()}>Save</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.tasks-page { display: flex; height: 100%; min-height: 0; }
	.t-side {
		width: 220px; flex: none;
		border-right: 1px solid var(--border);
		padding: 14px 10px;
		display: flex; flex-direction: column; gap: 2px;
		overflow-y: auto;
	}
	.t-nav {
		display: flex; align-items: center; gap: 8px;
		background: none; border: none; cursor: pointer;
		font-family: inherit; font-size: 13.5px; color: var(--text-2);
		padding: 8px 10px; border-radius: var(--r-2);
		text-align: left;
		transition: background var(--dur-1);
	}
	.t-nav:hover { background: var(--surface-2); color: var(--text-1); }
	.t-nav.on { background: color-mix(in oklab, var(--accent) 14%, transparent); color: var(--accent); font-weight: 600; }
	.t-ico { font-size: 14px; }
	.t-count { margin-left: auto; font-size: 11.5px; color: var(--text-3); }
	.t-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
	.t-sep { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); margin: 14px 10px 4px; }

	.t-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
	.t-head { display: flex; align-items: baseline; gap: 10px; padding: 16px 20px 8px; }
	.t-head h1 { font-family: var(--font-display); font-size: 22px; font-weight: 650; margin: 0; }
	.t-total { color: var(--text-3); font-size: 13px; }
	.quick-add { display: flex; gap: 8px; padding: 4px 20px 14px; }
	.qa-input {
		flex: 1;
		background: var(--surface-2);
		border: 1px solid var(--border); border-radius: var(--r-2);
		padding: 9px 14px;
		color: var(--text-1); font-family: inherit; font-size: 13.5px;
		outline: none;
		transition: border-color var(--dur-1);
	}
	.qa-input:focus { border-color: var(--accent); background: var(--surface-1); }

	.t-skels { padding: 0 20px; }
	.t-skel { height: 44px; border-radius: var(--r-2); margin-bottom: 8px; }
	.t-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-3); }
	.empty-art { font-size: 40px; }

	.t-list { list-style: none; margin: 0; padding: 0 12px 20px; overflow-y: auto; flex: 1; }
	.t-row {
		display: flex; align-items: center; gap: 10px;
		padding: 9px 14px; border-radius: var(--r-2);
		transition: background var(--dur-1);
	}
	.t-row:hover { background: var(--surface-1); }
	.t-row.sel { background: color-mix(in oklab, var(--accent) 9%, transparent); }
	.t-row.done .t-title { text-decoration: line-through; color: var(--text-3); }
	.t-check {
		width: 20px; height: 20px; flex: none;
		border: 1.5px solid var(--border); border-radius: 50%;
		background: none; cursor: pointer;
		color: var(--accent-contrast); font-size: 11px;
		display: grid; place-items: center;
		transition: all var(--dur-1);
	}
	.t-check:hover { border-color: var(--accent); }
	.t-check.on { background: var(--accent); border-color: var(--accent); }
	.t-body { flex: 1; min-width: 0; background: none; border: none; cursor: pointer; text-align: left; font-family: inherit; display: flex; flex-direction: column; gap: 1px; }
	.t-title { font-size: 14px; color: var(--text-1); }
	.t-desc { font-size: 12px; color: var(--text-3); max-width: 420px; }
	.t-prio { font-size: 11px; font-weight: 700; border-radius: 99px; padding: 1px 8px; background: var(--surface-2); color: var(--text-3); }
	.t-prio.high { background: color-mix(in oklab, var(--danger) 18%, transparent); color: var(--danger); }
	.t-prio.med { background: color-mix(in oklab, var(--warn) 18%, transparent); color: var(--warn); }
	.t-recur { color: var(--text-3); font-size: 12px; }
	.t-due { font-size: 12px; color: var(--text-3); flex: none; }
	.t-due.overdue { color: var(--danger); font-weight: 650; }
	.t-listtag {
		font-size: 11px; color: var(--text-3);
		border-left: 2px solid var(--c);
		padding-left: 6px; max-width: 110px; flex: none;
	}
	.t-acts { display: none; gap: 2px; }
	.t-row:hover .t-acts, .t-row.sel .t-acts { display: flex; }
	.t-act { background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 12px; padding: 3px 6px; border-radius: var(--r-1); }
	.t-act:hover { background: var(--surface-2); color: var(--text-1); }

	.overlay {
		position: fixed; inset: 0; z-index: 900;
		background: color-mix(in oklab, var(--bg) 45%, transparent);
		backdrop-filter: blur(2px);
		display: grid; place-items: center;
	}
	.edit {
		width: min(420px, calc(100vw - 32px));
		border-radius: var(--r-3); padding: 18px;
		box-shadow: var(--shadow-3);
		display: flex; flex-direction: column; gap: 10px;
		animation: pop-in var(--dur-2) var(--ease-spring);
	}
	@keyframes pop-in { from { opacity: 0; transform: scale(0.96) translateY(8px); } }
	.edit h3 { font-family: var(--font-display); margin: 0; font-size: 17px; }
	.edit .input.big { font-size: 15px; font-weight: 600; }
	.edit textarea { resize: vertical; font-family: inherit; }
	.edit-row { display: flex; gap: 10px; }
	.edit-row .lbl { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-3); }
	.edit footer { display: flex; justify-content: flex-end; gap: 8px; }
	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	@media (max-width: 760px) { .t-side { display: none; } }
	@media (prefers-reduced-motion: reduce) { .edit { animation: none; } }
</style>
