<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { fmtBytes, fmtTime, initials, avatarHue } from '$lib/client/format';
	import { toasts } from '$lib/client/toasts.svelte';
	import { buildZip } from '$lib/client/zip';
	import type { ListMessage } from './MessageList.svelte';

	interface Attachment { index: number; filename: string; contentType: string; size: number; cid: string | null }
	interface Invite {
		method: string; uid: string; summary: string; description: string; location: string;
		start: number; end: number; allDay: boolean; organizer: string | null; organizerName: string;
		attendees: { email: string; name: string; partstat: string }[]; sequence: number; icsIndex: number;
	}
	export interface MessageDetail {
		message: ListMessage;
		html: string;
		text: string;
		attachments: Attachment[];
		headers: {
			from: { name: string; address: string }[];
			to: { name: string; address: string }[];
			cc: { name: string; address: string }[];
			date: number;
			messageId: string | null;
			listUnsubscribe: string | null;
		};
		remoteImages: number;
		trackersBlocked: number;
		imagesAllowed: boolean;
		invite: Invite | null;
		isNewsletter: boolean;
	}

	interface Props {
		detail: MessageDetail;
		profileId: number;
		isDarkTheme: boolean;
		timeFormat: '12' | '24';
		onreply: (mode: 'reply' | 'replyAll' | 'forward') => void;
		onreload: (params: { images?: boolean; adapt?: boolean }) => void;
		onback: () => void;
		onmaketask: () => void;
		onarchivesender?: () => void;
	}

	let { detail, profileId, isDarkTheme, timeFormat, onreply, onreload, onback, onmaketask }: Props = $props();

	let iframeEl = $state<HTMLIFrameElement | null>(null);
	let iframeH = $state(300);
	let showPlain = $state(false);
	let readerMode = $state(false);
	let adaptDark = $state(true);
	let lightboxIdx = $state<number | null>(null);
	let unsubBusy = $state(false);
	let rsvpBusy = $state(false);
	let rsvpDone = $state('');
	let conflicts = $state<string[]>([]);
	let hoveredLink = $state('');

	const sender = $derived(detail.headers.from[0] ?? { name: '', address: '' });
	const senderDomain = $derived(sender.address.split('@')[1] ?? '');

	function onIframeLoad() {
		if (!iframeEl?.contentDocument) return;
		const doc = iframeEl.contentDocument;
		const resize = () => {
			iframeH = Math.min(Math.max(doc.documentElement.scrollHeight + 8, 80), 20000);
		};
		resize();
		// re-measure as images load
		setTimeout(resize, 250);
		setTimeout(resize, 1200);
		// link hover + safe open behavior
		for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
			const el = a as HTMLAnchorElement;
			el.setAttribute('target', '_blank');
			el.setAttribute('rel', 'noopener noreferrer');
			el.addEventListener('mouseenter', () => {
				hoveredLink = el.href;
				const text = el.textContent?.trim() ?? '';
				if (/^https?:\/\//.test(text)) {
					try {
						const textHost = new URL(text).hostname;
						const realHost = new URL(el.href).hostname;
						if (textHost !== realHost) hoveredLink = `⚠ Link text says ${textHost} but goes to ${realHost}`;
					} catch { /* not a URL */ }
				}
			});
			el.addEventListener('mouseleave', () => (hoveredLink = ''));
		}
	}

	async function allowImagesOnce() {
		onreload({ images: true });
	}
	async function trustSender(kind: 'sender' | 'domain') {
		await apiPost('/api/mail', { action: 'trust-sender', profileId, sender: kind === 'sender' ? sender.address : '@' + senderDomain });
		onreload({ images: true });
	}

	async function unsubscribe() {
		unsubBusy = true;
		try {
			const res = await apiPost<{ ok: boolean; method: string; url?: string }>('/api/mail', { action: 'unsubscribe', messageId: detail.message.id, profileId });
			if (res.method === 'link' && res.url) {
				window.open(res.url, '_blank', 'noopener,noreferrer');
				toasts.show('Opened the unsubscribe page in a new tab');
			} else {
				toasts.success(res.method === 'mailto' ? 'Unsubscribe email sent' : 'Unsubscribed');
			}
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Unsubscribe failed');
		} finally {
			unsubBusy = false;
		}
	}

	async function rsvp(partstat: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED') {
		if (!detail.invite) return;
		rsvpBusy = true;
		try {
			// fetch raw ics attachment
			const icsRes = await fetch(`/api/mail?view=attachment&profile=${profileId}&id=${detail.message.id}&att=${detail.invite.icsIndex}`);
			const rawIcs = await icsRes.text();
			// find own address among attendees
			const identities = await apiGet<{ identities: { email: string; name: string }[] }>(`/api/mail?view=identities&profile=${profileId}`);
			const own = identities.identities.find((i) => detail.invite!.attendees.some((a) => a.email.toLowerCase() === i.email.toLowerCase())) ?? identities.identities[0];
			if (!own) throw new Error('No sending identity configured');

			const res = await apiPost<{ ok: boolean; replyIcs: string; organizer: string | null; conflicts: string[] }>('/api/calendar', {
				action: 'rsvp', profileId, rawIcs, attendeeEmail: own.email, attendeeName: own.name, partstat
			});
			conflicts = res.conflicts ?? [];
			// send iMIP reply via mail
			if (res.organizer) {
				const identList = await apiGet<{ identities: { id: number; email: string }[] }>(`/api/mail?view=identities&profile=${profileId}`);
				const ident = identList.identities.find((i) => i.email.toLowerCase() === own.email.toLowerCase()) ?? identList.identities[0];
				await apiPost('/api/mail', {
					action: 'send', profileId, identityId: ident.id,
					to: [{ name: '', address: res.organizer.replace(/^mailto:/i, '') }], cc: [], bcc: [],
					subject: `${partstat === 'ACCEPTED' ? 'Accepted' : partstat === 'TENTATIVE' ? 'Tentative' : 'Declined'}: ${detail.invite.summary}`,
					html: `<p>${partstat === 'ACCEPTED' ? 'I will attend.' : partstat === 'TENTATIVE' ? 'I might attend.' : 'I cannot attend.'}</p>`,
					mode: 'new', delayOverride: 0, icalReply: res.replyIcs
				});
			}
			rsvpDone = partstat;
			toasts.success(partstat === 'DECLINED' ? 'Declined' : 'Added to calendar & replied');
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'RSVP failed');
		} finally {
			rsvpBusy = false;
		}
	}

	const imageAtts = $derived(detail.attachments.filter((a) => a.contentType.startsWith('image/') && !a.cid));
	const previewable = (a: Attachment) =>
		a.contentType.startsWith('image/') || a.contentType === 'application/pdf' || a.contentType.startsWith('text/');

	function attUrl(a: Attachment, dl = false) {
		return `/api/mail?view=attachment&profile=${profileId}&id=${detail.message.id}&att=${a.index}${dl ? '&dl=1' : ''}`;
	}

	async function downloadAllZip() {
		const t = toasts.show('Preparing zip…', 'progress', 0);
		try {
			const files = await Promise.all(
				detail.attachments.map(async (a) => ({
					name: a.filename,
					data: new Uint8Array(await (await fetch(attUrl(a))).arrayBuffer())
				}))
			);
			const blob = buildZip(files);
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = (detail.message.subject || 'attachments').replace(/[^\w\s-]/g, '').slice(0, 40) + '.zip';
			link.click();
			URL.revokeObjectURL(url);
		} catch {
			toasts.error('Could not build the zip');
		} finally {
			toasts.dismiss(t);
		}
	}

	function fmtDateFull(ms: number): string {
		return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: timeFormat === '12' }).format(new Date(ms));
	}
</script>

<article class="reading" aria-label="Message">
	<header class="msg-head">
		<button class="back-btn btn btn-ghost" onclick={onback} aria-label="Back to list" title="Back (u)">←</button>
		<h1 class="subject">{detail.message.subject || '(no subject)'}</h1>
		<div class="head-actions">
			<button class="btn btn-ghost" title="Reply (r)" onclick={() => onreply('reply')}>↩</button>
			<button class="btn btn-ghost" title="Reply all (a)" onclick={() => onreply('replyAll')}>↩↩</button>
			<button class="btn btn-ghost" title="Forward (f)" onclick={() => onreply('forward')}>→</button>
			<button class="btn btn-ghost" title="Create task (t)" onclick={onmaketask}>✓</button>
		</div>
	</header>

	<div class="sender-row">
		<span class="avatar" style="--av-h: {avatarHue(sender.address)}">{initials(sender.name || sender.address)}</span>
		<div class="sender-meta">
			<span class="sender-name">{sender.name || sender.address}</span>
			<span class="sender-detail">
				{sender.address}
				· to {detail.headers.to.map((t) => t.name || t.address).join(', ') || 'me'}
				{#if detail.headers.cc.length}· cc {detail.headers.cc.map((t) => t.name || t.address).join(', ')}{/if}
			</span>
		</div>
		<span class="msg-date tnum">{fmtDateFull(detail.headers.date)}</span>
	</div>

	{#if detail.trackersBlocked > 0}
		<div class="pill-row">
			<span class="pill shield" title="Tracking pixels and tracker URLs removed">🛡 {detail.trackersBlocked} tracker{detail.trackersBlocked === 1 ? '' : 's'} blocked</span>
		</div>
	{/if}

	{#if detail.remoteImages > 0 && !detail.imagesAllowed}
		<div class="banner">
			<span>Remote images blocked ({detail.remoteImages}).</span>
			<button class="btn" onclick={allowImagesOnce}>Load once</button>
			<button class="btn" onclick={() => trustSender('sender')}>Always from {sender.address}</button>
			<button class="btn" onclick={() => trustSender('domain')}>Always from @{senderDomain}</button>
		</div>
	{/if}

	{#if detail.invite}
		<div class="invite-card card">
			<div class="invite-head">
				<span class="invite-icon">📅</span>
				<div>
					<strong>{detail.invite.method === 'CANCEL' ? 'Cancelled: ' : detail.invite.method === 'REPLY' ? 'RSVP reply: ' : 'Invitation: '}{detail.invite.summary}</strong>
					<div class="invite-when tnum">
						{fmtDateFull(detail.invite.start)}{#if !detail.invite.allDay} – {fmtTime(detail.invite.end, timeFormat)}{/if}
					</div>
					{#if detail.invite.location}<div class="invite-loc">{detail.invite.location}</div>{/if}
					{#if detail.invite.organizerName || detail.invite.organizer}
						<div class="invite-org">Organized by {detail.invite.organizerName || detail.invite.organizer?.replace(/^mailto:/i, '')}</div>
					{/if}
				</div>
			</div>
			{#if conflicts.length > 0}
				<p class="conflict">⚠ Overlaps: {conflicts.join(', ')}</p>
			{/if}
			{#if detail.invite.method === 'REQUEST'}
				{#if rsvpDone}
					<p class="rsvp-done">{rsvpDone === 'ACCEPTED' ? '✓ Accepted' : rsvpDone === 'TENTATIVE' ? '? Tentative' : '✗ Declined'}</p>
				{:else}
					<div class="invite-actions">
						<button class="btn btn-primary" disabled={rsvpBusy} onclick={() => rsvp('ACCEPTED')}>Accept</button>
						<button class="btn" disabled={rsvpBusy} onclick={() => rsvp('TENTATIVE')}>Tentative</button>
						<button class="btn" disabled={rsvpBusy} onclick={() => rsvp('DECLINED')}>Decline</button>
					</div>
				{/if}
			{/if}
		</div>
	{/if}

	<div class="view-toggles">
		{#if detail.isNewsletter}
			<button class="toggle" class:on={readerMode} onclick={() => (readerMode = !readerMode)}>Reader mode</button>
		{/if}
		<button class="toggle" class:on={showPlain} onclick={() => (showPlain = !showPlain)}>Plain text</button>
		{#if isDarkTheme}
			<button class="toggle" class:on={!adaptDark} onclick={() => { adaptDark = !adaptDark; onreload({ adapt: adaptDark }); }}>Original colors</button>
		{/if}
		{#if detail.headers.listUnsubscribe}
			<button class="toggle unsub" disabled={unsubBusy} onclick={unsubscribe}>{unsubBusy ? 'Unsubscribing…' : 'Unsubscribe'}</button>
		{/if}
	</div>

	<div class="body-wrap" class:reader={readerMode}>
		{#if showPlain}
			<pre class="plain-body">{detail.text}</pre>
		{:else}
			<iframe
				bind:this={iframeEl}
				srcdoc={detail.html}
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				title="Email content"
				style="height: {iframeH}px"
				onload={onIframeLoad}
			></iframe>
		{/if}
	</div>

	{#if hoveredLink}
		<div class="link-status" role="status">{hoveredLink}</div>
	{/if}

	{#if detail.attachments.length > 0}
		<div class="attachments">
			<div class="att-head">
				<h2>{detail.attachments.length} attachment{detail.attachments.length === 1 ? '' : 's'}</h2>
				{#if detail.attachments.length > 1}
					<button class="btn" onclick={downloadAllZip}>Download all (.zip)</button>
				{/if}
			</div>
			<div class="att-grid">
				{#each detail.attachments.filter((a) => !a.cid) as a (a.index)}
					<div class="att-card">
						{#if a.contentType.startsWith('image/')}
							<button class="att-thumb" onclick={() => (lightboxIdx = imageAtts.indexOf(a))}>
								<img src={attUrl(a)} alt={a.filename} loading="lazy" />
							</button>
						{:else if previewable(a)}
							<a class="att-thumb file" href={attUrl(a)} target="_blank" rel="noopener noreferrer">
								<span class="file-glyph">{a.contentType === 'application/pdf' ? '📕' : '📄'}</span>
							</a>
						{:else}
							<span class="att-thumb file"><span class="file-glyph">📦</span></span>
						{/if}
						<div class="att-meta">
							<span class="att-name trunc" title={a.filename}>{a.filename}</span>
							<span class="att-size">{fmtBytes(a.size)}</span>
						</div>
						<a class="att-dl" href={attUrl(a, true)} download={a.filename} title="Download">⬇</a>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</article>

{#if lightboxIdx !== null && imageAtts[lightboxIdx]}
	<div class="lightbox" onclick={() => (lightboxIdx = null)} onkeydown={(e) => {
		if (e.key === 'Escape') lightboxIdx = null;
		else if (e.key === 'ArrowRight' && lightboxIdx !== null && lightboxIdx < imageAtts.length - 1) lightboxIdx++;
		else if (e.key === 'ArrowLeft' && lightboxIdx !== null && lightboxIdx > 0) lightboxIdx--;
	}} role="dialog" aria-modal="true" aria-label="Image preview" tabindex="-1">
		<img src={attUrl(imageAtts[lightboxIdx])} alt={imageAtts[lightboxIdx].filename} onclick={(e) => e.stopPropagation()} />
		{#if imageAtts.length > 1}
			<div class="lb-nav tnum">{lightboxIdx + 1} / {imageAtts.length}</div>
		{/if}
	</div>
{/if}

<style>
	.reading { flex: 1; overflow-y: auto; padding: 18px 22px 40px; position: relative; }
	.msg-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 14px; }
	.back-btn { flex: none; display: none; }
	.subject {
		font-family: var(--font-display);
		font-size: 20px; font-weight: 640; letter-spacing: -0.01em;
		margin: 0; flex: 1; min-width: 0; line-height: 1.3;
	}
	.head-actions { display: flex; gap: 2px; flex: none; }
	.sender-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
	.avatar {
		width: 38px; height: 38px; flex: none;
		display: grid; place-items: center;
		border-radius: 50%;
		background: oklch(0.5 0.1 var(--av-h) / 0.35);
		color: var(--text-1); font-size: 13px; font-weight: 650;
	}
	.sender-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.sender-name { font-weight: 620; font-size: 14px; }
	.sender-detail { font-size: 12.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.msg-date { font-size: 12.5px; color: var(--text-3); flex: none; }
	.pill-row { margin-bottom: 10px; }
	.pill {
		display: inline-flex; align-items: center; gap: 5px;
		font-size: 12px; color: var(--text-2);
		background: var(--surface-1); border: 1px solid var(--border);
		border-radius: 99px; padding: 3px 10px;
	}
	.banner {
		display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
		background: color-mix(in oklab, var(--warn) 10%, var(--surface-1));
		border: 1px solid color-mix(in oklab, var(--warn) 30%, var(--border));
		border-radius: var(--r-2); padding: 9px 12px;
		font-size: 13px; margin-bottom: 12px;
	}
	.banner .btn { padding: 3px 10px; font-size: 12.5px; }
	.invite-card { padding: 16px; margin-bottom: 14px; }
	.invite-head { display: flex; gap: 12px; }
	.invite-icon { font-size: 22px; }
	.invite-when { font-size: 13px; color: var(--text-2); margin-top: 2px; }
	.invite-loc, .invite-org { font-size: 12.5px; color: var(--text-3); margin-top: 2px; }
	.invite-actions { display: flex; gap: 8px; margin-top: 12px; }
	.conflict { color: var(--warn); font-size: 13px; margin: 10px 0 0; }
	.rsvp-done { color: var(--success); font-weight: 600; font-size: 13.5px; margin: 10px 0 0; }
	.view-toggles { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
	.toggle {
		background: var(--surface-1); border: 1px solid var(--border);
		border-radius: 99px; padding: 3px 11px;
		font-size: 12px; color: var(--text-2); cursor: pointer; font-family: inherit;
		transition: all var(--dur-1);
	}
	.toggle.on { background: color-mix(in oklab, var(--accent) 16%, transparent); border-color: var(--accent); color: var(--accent); }
	.toggle.unsub { margin-left: auto; }
	.body-wrap {
		background: var(--surface-0);
		border: 1px solid var(--border);
		border-radius: var(--r-3);
		overflow: hidden;
	}
	.body-wrap.reader { max-width: 640px; margin: 0 auto; }
	iframe { display: block; width: 100%; border: none; background: transparent; }
	.plain-body {
		white-space: pre-wrap; font-family: var(--font-ui);
		font-size: 14px; line-height: 1.6; padding: 18px; margin: 0;
		overflow-wrap: break-word;
	}
	.link-status {
		position: sticky; bottom: 8px;
		display: inline-block; max-width: 100%;
		background: var(--surface-2); border: 1px solid var(--border);
		border-radius: var(--r-1); padding: 4px 10px;
		font-size: 12px; color: var(--text-2);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		margin-top: 8px;
	}
	.attachments { margin-top: 18px; }
	.att-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
	.att-head h2 { font-size: 13px; font-weight: 600; color: var(--text-2); margin: 0; }
	.att-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
	.att-card {
		position: relative;
		border: 1px solid var(--border); border-radius: var(--r-2);
		overflow: hidden; background: var(--surface-1);
	}
	.att-thumb {
		display: block; width: 100%; aspect-ratio: 16/10;
		background: var(--surface-2); border: none; cursor: pointer; padding: 0;
	}
	.att-thumb img { width: 100%; height: 100%; object-fit: cover; }
	.att-thumb.file { display: grid; place-items: center; text-decoration: none; }
	.file-glyph { font-size: 28px; }
	.att-meta { padding: 7px 9px; display: flex; flex-direction: column; gap: 1px; }
	.att-name { font-size: 12px; font-weight: 550; }
	.att-size { font-size: 11px; color: var(--text-3); }
	.att-dl {
		position: absolute; top: 6px; right: 6px;
		background: color-mix(in oklab, var(--bg) 70%, transparent);
		border-radius: var(--r-1); padding: 2px 7px;
		text-decoration: none; color: var(--text-1); font-size: 13px;
		opacity: 0; transition: opacity var(--dur-1);
	}
	.att-card:hover .att-dl { opacity: 1; }
	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lightbox {
		position: fixed; inset: 0; z-index: 950;
		background: rgba(0, 0, 0, 0.82);
		display: grid; place-items: center; padding: 30px;
	}
	.lightbox img { max-width: 100%; max-height: 90vh; border-radius: var(--r-2); box-shadow: var(--shadow-3); }
	.lb-nav { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); color: #fff; font-size: 13px; }
	@media (max-width: 860px) {
		.back-btn { display: inline-flex; }
		.reading { padding: 14px; }
	}
</style>
