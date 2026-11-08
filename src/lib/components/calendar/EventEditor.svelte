<script lang="ts">
	import { apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';

	export interface CalInfo { id: number; name: string; color: string | null; is_default: number }
	export interface EditorEvent {
		objectId?: number;
		calendarId: number;
		summary: string;
		description: string;
		location: string;
		start: number;
		end: number;
		allDay: boolean;
		isRecurring: boolean;
		recurrenceStart?: number; // the occurrence's start (for scope=one edits)
		rrule?: string;
		attendees?: { email: string; name: string }[];
	}

	interface Props {
		event: EditorEvent;
		calendars: CalInfo[];
		profileId: number;
		organizerEmail: string | null;
		onsaved: () => void;
		onclose: () => void;
	}

	let { event, calendars, profileId, organizerEmail, onsaved, onclose }: Props = $props();

	const isNew = !event.objectId;

	let summary = $state(event.summary);
	let description = $state(event.description);
	let location = $state(event.location);
	let allDay = $state(event.allDay);
	let calendarId = $state(event.calendarId);
	let attendeesText = $state((event.attendees ?? []).map((a) => a.email).join(', '));
	let busy = $state(false);
	let scopePrompt = $state<'update' | 'delete' | null>(null);

	function toLocalInput(ms: number, dateOnly = false): string {
		const d = new Date(ms);
		const pad = (n: number) => String(n).padStart(2, '0');
		const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		return dateOnly ? date : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	let startStr = $state(toLocalInput(event.start, event.allDay));
	let endStr = $state(toLocalInput(event.allDay ? event.end - 86400000 : event.end, event.allDay));

	// ---- alarms ----
	let alarms = $state<number[]>([]);
	const alarmOptions = [
		{ label: 'At time of event', v: 0 },
		{ label: '5 minutes before', v: 5 },
		{ label: '15 minutes before', v: 15 },
		{ label: '30 minutes before', v: 30 },
		{ label: '1 hour before', v: 60 },
		{ label: '1 day before', v: 1440 }
	];

	// ---- recurrence builder ----
	type Freq = '' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
	let freq = $state<Freq>('');
	let interval = $state(1);
	let byDays = $state<string[]>([]);
	let monthlyMode = $state<'bymonthday' | 'byday'>('bymonthday');
	let endMode = $state<'never' | 'count' | 'until'>('never');
	let count = $state(10);
	let untilStr = $state('');
	const weekdays = [
		{ code: 'MO', label: 'M' }, { code: 'TU', label: 'T' }, { code: 'WE', label: 'W' },
		{ code: 'TH', label: 'T' }, { code: 'FR', label: 'F' }, { code: 'SA', label: 'S' }, { code: 'SU', label: 'S' }
	];

	// parse existing rrule into builder state
	$effect(() => {
		if (!event.rrule) return;
		const parts = Object.fromEntries(event.rrule.replace(/^RRULE:/, '').split(';').map((p) => p.split('=') as [string, string]));
		freq = (parts.FREQ as Freq) ?? '';
		interval = parseInt(parts.INTERVAL ?? '1', 10);
		if (parts.BYDAY) {
			byDays = parts.BYDAY.split(',').map((d) => d.replace(/^-?\d+/, ''));
			if (freq === 'MONTHLY') monthlyMode = 'byday';
		}
		if (parts.COUNT) { endMode = 'count'; count = parseInt(parts.COUNT, 10); }
		else if (parts.UNTIL) {
			endMode = 'until';
			const u = parts.UNTIL;
			untilStr = `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`;
		}
	});

	function buildRrule(): string | undefined {
		if (!freq) return undefined;
		const start = new Date(startStr);
		const parts = [`FREQ=${freq}`];
		if (interval > 1) parts.push(`INTERVAL=${interval}`);
		if (freq === 'WEEKLY' && byDays.length > 0) parts.push(`BYDAY=${byDays.join(',')}`);
		if (freq === 'MONTHLY') {
			if (monthlyMode === 'bymonthday') parts.push(`BYMONTHDAY=${start.getDate()}`);
			else {
				const nth = Math.ceil(start.getDate() / 7);
				const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
				parts.push(`BYDAY=${nth >= 5 ? -1 : nth}${codes[start.getDay()]}`);
			}
		}
		if (endMode === 'count') parts.push(`COUNT=${Math.max(1, count)}`);
		else if (endMode === 'until' && untilStr) {
			parts.push(`UNTIL=${untilStr.replace(/-/g, '')}T235959Z`);
		}
		return parts.join(';');
	}

	function parseTimes(): { start: number; end: number } | null {
		if (allDay) {
			const s = new Date(startStr + 'T00:00');
			const e = new Date(endStr + 'T00:00');
			if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
			return { start: s.getTime(), end: e.getTime() + 86400000 }; // DTEND exclusive
		}
		const s = new Date(startStr);
		const e = new Date(endStr);
		if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) return null;
		return { start: s.getTime(), end: e.getTime() };
	}

	function onAllDayToggle() {
		startStr = toLocalInput(new Date(startStr.length > 10 ? startStr : startStr + 'T09:00').getTime(), allDay);
		endStr = toLocalInput(new Date(endStr.length > 10 ? endStr : endStr + 'T10:00').getTime(), allDay);
	}

	async function save(scope?: 'one' | 'all') {
		const times = parseTimes();
		if (!summary.trim()) { toasts.error('Give the event a title'); return; }
		if (!times) { toasts.error('The end must be after the start'); return; }

		// recurring existing event without a decided scope → ask
		if (!isNew && event.isRecurring && !scope) { scopePrompt = 'update'; return; }

		busy = true;
		try {
			const attendees = attendeesText.split(/[,;\s]+/).filter((a) => a.includes('@')).map((email) => ({ email, name: '' }));
			if (isNew) {
				const res = await apiPost<{ ok: boolean; inviteIcs: string | null }>('/api/calendar', {
					action: 'create',
					calendarId, summary, description, location,
					start: times.start, end: times.end, allDay,
					rrule: buildRrule(),
					alarms: alarms.length ? alarms : undefined,
					attendees: attendees.length ? attendees : undefined,
					organizerEmail: attendees.length ? organizerEmail : undefined
				});
				if (res.inviteIcs && attendees.length && organizerEmail) {
					await sendInvites(res.inviteIcs, attendees);
				}
				toasts.success('Event created');
			} else {
				await apiPost('/api/calendar', {
					action: 'update',
					calendarId: event.calendarId, objectId: event.objectId,
					scope: scope === 'one' ? 'one' : undefined,
					occurrenceStart: scope === 'one' ? event.recurrenceStart ?? event.start : undefined,
					summary, description, location,
					start: times.start, end: times.end, allDay,
					rrule: scope === 'one' ? undefined : buildRrule()
				});
				toasts.success('Event updated');
			}
			onsaved();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not save the event');
		} finally {
			busy = false;
		}
	}

	async function sendInvites(ics: string, attendees: { email: string; name: string }[]) {
		try {
			const idRes = await fetch(`/api/mail?view=identities&profile=${profileId}`);
			const { identities } = await idRes.json() as { identities: { id: number; email: string; is_default: number }[] };
			const identity = identities.find((i) => i.email === organizerEmail) ?? identities.find((i) => i.is_default) ?? identities[0];
			if (!identity) return;
			await apiPost('/api/mail', {
				action: 'send', profileId, identityId: identity.id,
				to: attendees.map((a) => ({ name: a.name, address: a.email })), cc: [], bcc: [],
				subject: `Invitation: ${summary}`,
				html: `<p>You have been invited to <strong>${summary.replace(/</g, '&lt;')}</strong>.</p><p>${new Date(parseTimes()!.start).toLocaleString()}${location ? ` · ${location.replace(/</g, '&lt;')}` : ''}</p>`,
				attachments: [{ filename: 'invite.ics', contentType: 'text/calendar; method=REQUEST', dataBase64: btoa(unescape(encodeURIComponent(ics))) }],
				mode: 'new', delayOverride: 0
			});
			toasts.show('Invitations sent');
		} catch {
			toasts.error('Event saved, but sending invitations failed');
		}
	}

	async function del(scope?: 'one' | 'following' | 'all') {
		if (event.isRecurring && !scope) { scopePrompt = 'delete'; return; }
		busy = true;
		try {
			await apiPost('/api/calendar', {
				action: 'delete',
				calendarId: event.calendarId, objectId: event.objectId,
				scope: scope ?? 'all',
				occurrenceStart: event.recurrenceStart ?? event.start
			});
			toasts.success('Event deleted');
			onsaved();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Could not delete');
		} finally {
			busy = false;
		}
	}
</script>

<div class="overlay" role="presentation" onclick={onclose} onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}>
	<div class="editor glass" role="dialog" aria-label={isNew ? 'New event' : 'Edit event'} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
		<header>
			<h3>{isNew ? 'New event' : 'Edit event'}</h3>
			<button class="x" onclick={onclose} aria-label="Close">✕</button>
		</header>

		<input class="title-input" type="text" bind:value={summary} placeholder="Event title" aria-label="Title" />

		<div class="row">
			<label class="lbl" for="ev-cal">Calendar</label>
			<select id="ev-cal" class="input" bind:value={calendarId} disabled={!isNew}>
				{#each calendars as c (c.id)}
					<option value={c.id}>{c.name}</option>
				{/each}
			</select>
		</div>

		<div class="row">
			<label class="chk"><input type="checkbox" bind:checked={allDay} onchange={onAllDayToggle} /> All day</label>
		</div>

		<div class="row two">
			<div>
				<label class="lbl" for="ev-start">Starts</label>
				{#if allDay}
					<input id="ev-start" class="input" type="date" bind:value={startStr} />
				{:else}
					<input id="ev-start" class="input" type="datetime-local" bind:value={startStr} />
				{/if}
			</div>
			<div>
				<label class="lbl" for="ev-end">Ends</label>
				{#if allDay}
					<input id="ev-end" class="input" type="date" bind:value={endStr} />
				{:else}
					<input id="ev-end" class="input" type="datetime-local" bind:value={endStr} />
				{/if}
			</div>
		</div>

		<div class="row">
			<label class="lbl" for="ev-loc">Location</label>
			<input id="ev-loc" class="input" type="text" bind:value={location} placeholder="Add location or link" />
		</div>

		<div class="row">
			<label class="lbl" for="ev-att">Attendees</label>
			<input id="ev-att" class="input" type="text" bind:value={attendeesText} placeholder="emails, comma separated" disabled={!isNew} />
		</div>

		<div class="row">
			<label class="lbl" for="ev-desc">Notes</label>
			<textarea id="ev-desc" class="input" rows="3" bind:value={description} placeholder="Description"></textarea>
		</div>

		<!-- recurrence -->
		<details class="section" open={!!event.rrule}>
			<summary>Repeat {freq ? `· ${freq.toLowerCase()}` : ''}</summary>
			<div class="row">
				<select class="input" bind:value={freq} aria-label="Repeat frequency">
					<option value="">Does not repeat</option>
					<option value="DAILY">Daily</option>
					<option value="WEEKLY">Weekly</option>
					<option value="MONTHLY">Monthly</option>
					<option value="YEARLY">Yearly</option>
				</select>
				{#if freq}
					<span class="inline-lbl">every</span>
					<input class="input num" type="number" min="1" max="99" bind:value={interval} aria-label="Interval" />
					<span class="inline-lbl">{freq === 'DAILY' ? 'day(s)' : freq === 'WEEKLY' ? 'week(s)' : freq === 'MONTHLY' ? 'month(s)' : 'year(s)'}</span>
				{/if}
			</div>
			{#if freq === 'WEEKLY'}
				<div class="row weekday-row" role="group" aria-label="Repeat on days">
					{#each weekdays as d (d.code)}
						<button
							class="wd" class:on={byDays.includes(d.code)}
							onclick={() => (byDays = byDays.includes(d.code) ? byDays.filter((x) => x !== d.code) : [...byDays, d.code])}
							aria-pressed={byDays.includes(d.code)}
						>{d.label}</button>
					{/each}
				</div>
			{/if}
			{#if freq === 'MONTHLY'}
				<div class="row">
					<select class="input" bind:value={monthlyMode} aria-label="Monthly pattern">
						<option value="bymonthday">On day {new Date(startStr).getDate() || ''}</option>
						<option value="byday">On the {Math.ceil((new Date(startStr).getDate() || 1) / 7)}{['th','st','nd','rd'][Math.ceil((new Date(startStr).getDate() || 1) / 7)] ?? 'th'} {new Date(startStr).toLocaleDateString(undefined, { weekday: 'long' })}</option>
					</select>
				</div>
			{/if}
			{#if freq}
				<div class="row">
					<select class="input" bind:value={endMode} aria-label="Repeat ends">
						<option value="never">Never ends</option>
						<option value="count">Ends after…</option>
						<option value="until">Ends on date…</option>
					</select>
					{#if endMode === 'count'}
						<input class="input num" type="number" min="1" bind:value={count} aria-label="Occurrence count" />
						<span class="inline-lbl">times</span>
					{:else if endMode === 'until'}
						<input class="input" type="date" bind:value={untilStr} aria-label="End date" />
					{/if}
				</div>
			{/if}
		</details>

		<!-- reminders -->
		{#if isNew}
			<details class="section">
				<summary>Reminders {alarms.length ? `· ${alarms.length}` : ''}</summary>
				<div class="row alarm-row">
					{#each alarmOptions as o (o.v)}
						<button class="wd alarm" class:on={alarms.includes(o.v)}
							onclick={() => (alarms = alarms.includes(o.v) ? alarms.filter((a) => a !== o.v) : [...alarms, o.v])}
							aria-pressed={alarms.includes(o.v)}
						>{o.label}</button>
					{/each}
				</div>
			</details>
		{/if}

		<footer>
			{#if !isNew}
				<button class="btn danger" onclick={() => void del()} disabled={busy}>Delete</button>
			{/if}
			<span class="grow"></span>
			<button class="btn btn-ghost" onclick={onclose}>Cancel</button>
			<button class="btn btn-primary" onclick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
		</footer>

		{#if scopePrompt}
			<div class="scope glass" role="alertdialog" aria-label="Apply to which events?">
				<p>This is a repeating event. {scopePrompt === 'delete' ? 'Delete' : 'Change'}…</p>
				<button class="btn" onclick={() => { const p = scopePrompt; scopePrompt = null; p === 'delete' ? void del('one') : void save('one'); }}>This event only</button>
				{#if scopePrompt === 'delete'}
					<button class="btn" onclick={() => { scopePrompt = null; void del('following'); }}>This and following</button>
				{/if}
				<button class="btn" onclick={() => { const p = scopePrompt; scopePrompt = null; p === 'delete' ? void del('all') : void save('all'); }}>All events</button>
				<button class="btn btn-ghost" onclick={() => (scopePrompt = null)}>Cancel</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.overlay {
		position: fixed; inset: 0; z-index: 900;
		background: color-mix(in oklab, var(--bg) 45%, transparent);
		backdrop-filter: blur(2px);
		display: grid; place-items: center;
	}
	.editor {
		position: relative;
		width: min(480px, calc(100vw - 32px));
		max-height: 88vh; overflow-y: auto;
		border-radius: var(--r-3);
		box-shadow: var(--shadow-3);
		padding: 18px;
		animation: pop-in var(--dur-2) var(--ease-spring);
	}
	@keyframes pop-in { from { opacity: 0; transform: scale(0.96) translateY(8px); } }
	header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
	h3 { font-family: var(--font-display); font-size: 17px; margin: 0; }
	.x { background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 13px; padding: 4px 8px; border-radius: var(--r-1); }
	.x:hover { background: var(--surface-2); color: var(--text-1); }
	.title-input {
		width: 100%;
		background: none; border: none; outline: none;
		border-bottom: 2px solid var(--border);
		font-family: var(--font-display); font-size: 19px; font-weight: 620;
		color: var(--text-1);
		padding: 6px 2px 10px;
		margin-bottom: 14px;
		transition: border-color var(--dur-1);
	}
	.title-input:focus { border-color: var(--accent); }
	.row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
	.row.two > div { flex: 1; min-width: 150px; }
	.lbl { display: block; font-size: 12px; color: var(--text-3); margin-bottom: 3px; }
	.row .input { width: 100%; }
	.row:not(.two) .input { flex: 1; width: auto; }
	.chk { display: flex; align-items: center; gap: 7px; font-size: 13.5px; cursor: pointer; }
	.section { margin: 12px 0; border: 1px solid var(--border); border-radius: var(--r-2); padding: 10px 12px; }
	.section summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--text-2); }
	.section .row { margin-top: 10px; }
	.inline-lbl { font-size: 13px; color: var(--text-3); }
	.num { width: 64px !important; flex: none !important; }
	.weekday-row { gap: 4px; }
	.wd {
		min-width: 32px; height: 32px;
		border-radius: 50%; border: 1px solid var(--border);
		background: var(--surface-1); color: var(--text-2);
		cursor: pointer; font-family: inherit; font-size: 12.5px;
		transition: all var(--dur-1);
	}
	.wd.on { background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); }
	.wd.alarm { border-radius: 99px; padding: 0 12px; }
	footer { display: flex; gap: 8px; margin-top: 16px; }
	.grow { flex: 1; }
	.danger { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 40%, transparent); }
	.scope {
		position: absolute; inset: auto 16px 16px 16px; z-index: 10;
		border-radius: var(--r-2); padding: 14px;
		box-shadow: var(--shadow-3);
		display: flex; flex-direction: column; gap: 6px;
	}
	.scope p { margin: 0 0 6px; font-size: 13.5px; font-weight: 600; }
	textarea.input { resize: vertical; font-family: inherit; }
	@media (prefers-reduced-motion: reduce) { .editor { animation: none; } }
</style>
