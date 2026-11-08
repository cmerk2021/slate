<script lang="ts">
	import { apiGet, apiPost } from '$lib/client/api';
	import { toasts } from '$lib/client/toasts.svelte';
	import { fmtBytes } from '$lib/client/format';

	export interface Identity { id: number; account_id: number; email: string; name: string; signature_html: string; is_default: number; account_name?: string }
	export interface ComposerPrefill {
		to?: { name: string; address: string }[];
		cc?: { name: string; address: string }[];
		subject?: string;
		html?: string;
		attachments?: { filename: string; contentType: string; dataBase64: string }[];
		replyToMessageId?: number;
		mode?: 'reply' | 'replyAll' | 'forward' | 'new';
	}

	interface Props {
		profileId: number;
		identities: Identity[];
		prefill: ComposerPrefill;
		undoSendSeconds: number;
		onclose: () => void;
	}

	let { profileId, identities, prefill, undoSendSeconds, onclose }: Props = $props();

	interface Chip { name: string; address: string }
	interface Att { filename: string; contentType: string; data: Uint8Array; cid?: string }

	let to = $state<Chip[]>(prefill.to ?? []);
	let cc = $state<Chip[]>(prefill.cc ?? []);
	let bcc = $state<Chip[]>([]);
	let showCcBcc = $state((prefill.cc?.length ?? 0) > 0);
	let subject = $state(prefill.subject ?? '');
	let identityId = $state(identities.find((i) => i.is_default)?.id ?? identities[0]?.id ?? 0);
	let attachments = $state<Att[]>((prefill.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, data: Uint8Array.from(atob(a.dataBase64), (c) => c.charCodeAt(0)) })));
	let minimized = $state(false);
	let markdownMode = $state(false);
	let markdownText = $state('');
	let sending = $state(false);
	let draftId = $state<number | undefined>(undefined);
	let draftSavedAt = $state(0);
	let dragOver = $state(false);

	let editorEl = $state<HTMLDivElement | null>(null);
	let toInput = $state('');
	let ccInput = $state('');
	let bccInput = $state('');
	let activeField = $state<'to' | 'cc' | 'bcc' | null>(null);
	let suggestions = $state<Chip[]>([]);
	let sugIdx = $state(0);
	let sugTimer: ReturnType<typeof setTimeout> | null = null;
	let dirty = $state(false);
	let autosaveTimer: ReturnType<typeof setInterval> | null = null;

	const identity = $derived(identities.find((i) => i.id === identityId));

	// initialize editor content once mounted
	$effect(() => {
		if (editorEl && !editorEl.dataset.initialized) {
			editorEl.dataset.initialized = '1';
			let html = prefill.html ?? '<p></p>';
			if ((prefill.mode ?? 'new') !== 'forward' && identity?.signature_html) {
				// insert signature above quoted text
				const sig = `<div class="sig">${identity.signature_html}</div>`;
				const qi = html.indexOf('<blockquote');
				html = qi >= 0 ? html.slice(0, qi) + sig + html.slice(qi) : html + sig;
			}
			editorEl.innerHTML = html;
			placeCaretAtStart();
		}
	});

	function placeCaretAtStart() {
		if (!editorEl) return;
		editorEl.focus();
		const range = document.createRange();
		range.setStart(editorEl.firstChild ?? editorEl, 0);
		range.collapse(true);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}

	// ---- autosave ----
	$effect(() => {
		autosaveTimer = setInterval(() => {
			if (dirty) void saveDraft();
		}, 5000);
		return () => { if (autosaveTimer) clearInterval(autosaveTimer); };
	});

	async function saveDraft() {
		if (!identityId || sending) return;
		dirty = false;
		try {
			const res = await apiPost<{ ok: boolean; draftId: number }>('/api/mail', {
				action: 'save-draft', profileId, identityId, draftId,
				data: { to, cc, bcc, subject, html: currentHtml() }
			});
			draftId = res.draftId;
			draftSavedAt = Date.now();
		} catch { /* retried next tick */ }
	}

	function currentHtml(): string {
		if (markdownMode) return markdownToHtml(markdownText);
		return editorEl?.innerHTML ?? '';
	}

	// ---- chips ----
	const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	function commitChip(field: 'to' | 'cc' | 'bcc', raw?: string) {
		const input = raw ?? (field === 'to' ? toInput : field === 'cc' ? ccInput : bccInput);
		const parts = input.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
		for (const part of parts) {
			const m = part.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
			const chip = m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: part };
			if (!emailRe.test(chip.address)) continue;
			const list = field === 'to' ? to : field === 'cc' ? cc : bcc;
			if (!list.some((c) => c.address.toLowerCase() === chip.address.toLowerCase())) {
				if (field === 'to') to = [...to, chip];
				else if (field === 'cc') cc = [...cc, chip];
				else bcc = [...bcc, chip];
			}
		}
		if (field === 'to') toInput = ''; else if (field === 'cc') ccInput = ''; else bccInput = '';
		suggestions = [];
		dirty = true;
	}

	function removeChip(field: 'to' | 'cc' | 'bcc', i: number) {
		if (field === 'to') to = to.toSpliced(i, 1);
		else if (field === 'cc') cc = cc.toSpliced(i, 1);
		else bcc = bcc.toSpliced(i, 1);
		dirty = true;
	}

	function onChipKeydown(e: KeyboardEvent, field: 'to' | 'cc' | 'bcc') {
		const input = field === 'to' ? toInput : field === 'cc' ? ccInput : bccInput;
		if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); sugIdx = Math.min(sugIdx + 1, suggestions.length - 1); }
		else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); sugIdx = Math.max(sugIdx - 1, 0); }
		else if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && (input || suggestions.length)) {
			if (suggestions.length && suggestions[sugIdx]) {
				e.preventDefault();
				pickSuggestion(field, suggestions[sugIdx]);
			} else if (input) {
				e.preventDefault();
				commitChip(field);
			}
		} else if (e.key === 'Backspace' && !input) {
			const list = field === 'to' ? to : field === 'cc' ? cc : bcc;
			if (list.length) removeChip(field, list.length - 1);
		} else if (e.key === 'Escape') {
			suggestions = [];
		}
	}

	function pickSuggestion(field: 'to' | 'cc' | 'bcc', s: Chip) {
		commitChip(field, s.name ? `"${s.name}" <${s.address}>` : s.address);
	}

	function onChipInput(field: 'to' | 'cc' | 'bcc') {
		activeField = field;
		const q = (field === 'to' ? toInput : field === 'cc' ? ccInput : bccInput).trim();
		if (sugTimer) clearTimeout(sugTimer);
		if (q.length < 2) { suggestions = []; return; }
		sugTimer = setTimeout(async () => {
			try {
				const res = await apiGet<{ results: Chip[] }>(`/api/contacts?profile=${profileId}&view=autocomplete&q=${encodeURIComponent(q)}`);
				suggestions = res.results;
				sugIdx = 0;
			} catch { suggestions = []; }
		}, 180);
	}

	function onPasteChips(e: ClipboardEvent, field: 'to' | 'cc' | 'bcc') {
		const text = e.clipboardData?.getData('text') ?? '';
		if (/[,;\n]/.test(text) || /<[^>]+>/.test(text)) {
			e.preventDefault();
			commitChip(field, text);
		}
	}

	// ---- markdown input rules in rich mode ----
	function onEditorKeydown(e: KeyboardEvent) {
		dirty = true;
		if (e.key === ' ' || e.key === 'Enter') {
			applyMarkdownRule(e);
		}
		// basic formatting shortcuts
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
			if (e.key === 'b') { e.preventDefault(); document.execCommand('bold'); }
			else if (e.key === 'i') { e.preventDefault(); document.execCommand('italic'); }
			else if (e.key === 'u') { e.preventDefault(); document.execCommand('underline'); }
		}
	}

	function applyMarkdownRule(e: KeyboardEvent) {
		const sel = window.getSelection();
		if (!sel?.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) return;
		const node = sel.anchorNode as Text;
		const text = node.textContent ?? '';
		const upTo = text.slice(0, sel.anchorOffset);

		const lineStart = /^(\s*)$/.test(upTo) ? null : upTo;
		if (lineStart === null) return;

		// block rules: trigger on space after marker at line start
		const blockEl = node.parentElement?.closest('p, div') as HTMLElement | null;
		if (e.key === ' ' && blockEl && blockEl.textContent === upTo) {
			const rules: [RegExp, () => void][] = [
				[/^#$/, () => document.execCommand('formatBlock', false, 'h2')],
				[/^##$/, () => document.execCommand('formatBlock', false, 'h3')],
				[/^[-*]$/, () => document.execCommand('insertUnorderedList')],
				[/^1\.$/, () => document.execCommand('insertOrderedList')],
				[/^>$/, () => document.execCommand('formatBlock', false, 'blockquote')]
			];
			for (const [re, run] of rules) {
				if (re.test(upTo.trim())) {
					e.preventDefault();
					// remove the marker text
					node.textContent = text.slice(sel.anchorOffset);
					run();
					return;
				}
			}
		}

		// inline rules: **bold**, *italic*, `code` — applied on space/enter
		const inline: [RegExp, string][] = [
			[/\*\*([^*]+)\*\*$/, 'strong'],
			[/(?<!\*)\*([^*]+)\*$/, 'em'],
			[/`([^`]+)`$/, 'code']
		];
		for (const [re, tag] of inline) {
			const m = upTo.match(re);
			if (m) {
				const full = m[0];
				const inner = m[1];
				const start = sel.anchorOffset - full.length;
				const range = document.createRange();
				range.setStart(node, start);
				range.setEnd(node, sel.anchorOffset);
				range.deleteContents();
				const el = document.createElement(tag);
				el.textContent = inner;
				range.insertNode(el);
				// move caret after the new element with a trailing space handled by the key event
				const after = document.createRange();
				after.setStartAfter(el);
				after.collapse(true);
				sel.removeAllRanges();
				sel.addRange(after);
				return;
			}
		}
	}

	function exec(cmd: string, val?: string) {
		editorEl?.focus();
		document.execCommand(cmd, false, val);
		dirty = true;
	}

	function insertLink() {
		const url = prompt('Link URL:');
		if (url) exec('createLink', url);
	}

	// ---- markdown mode ----
	function markdownToHtml(md: string): string {
		const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const lines = md.split('\n');
		const out: string[] = [];
		let inList: string | null = null;
		let inCode = false;
		const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
		for (const line of lines) {
			if (line.startsWith('```')) {
				if (inCode) { out.push('</code></pre>'); inCode = false; }
				else { closeList(); out.push('<pre><code>'); inCode = true; }
				continue;
			}
			if (inCode) { out.push(esc(line)); continue; }
			const inlined = esc(line)
				.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
				.replace(/(?<!\*)\*([^*]+)\*/g, '<em>$1</em>')
				.replace(/`([^`]+)`/g, '<code>$1</code>')
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
			if (/^#{1,3} /.test(line)) {
				closeList();
				const level = line.match(/^(#{1,3}) /)![1].length;
				out.push(`<h${level + 1}>${inlined.replace(/^#{1,3} /, '')}</h${level + 1}>`);
			} else if (/^[-*] /.test(line)) {
				if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
				out.push(`<li>${inlined.slice(2)}</li>`);
			} else if (/^\d+\. /.test(line)) {
				if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
				out.push(`<li>${inlined.replace(/^\d+\. /, '')}</li>`);
			} else if (/^> /.test(line)) {
				closeList();
				out.push(`<blockquote>${inlined.slice(5)}</blockquote>`);
			} else if (line.trim() === '') {
				closeList();
			} else {
				closeList();
				out.push(`<p>${inlined}</p>`);
			}
		}
		closeList();
		if (inCode) out.push('</code></pre>');
		return out.join('\n');
	}

	function htmlToMarkdownish(html: string): string {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		return doc.body.innerText;
	}

	function toggleMarkdown() {
		if (!markdownMode) {
			markdownText = htmlToMarkdownish(editorEl?.innerHTML ?? '');
			markdownMode = true;
		} else {
			markdownMode = false;
			requestAnimationFrame(() => {
				if (editorEl) editorEl.innerHTML = markdownToHtml(markdownText);
			});
		}
	}

	// ---- attachments ----
	async function addFiles(files: FileList | File[]) {
		for (const f of Array.from(files)) {
			const data = new Uint8Array(await f.arrayBuffer());
			if (f.type.startsWith('image/') && editorEl && document.activeElement === editorEl) {
				// paste image inline via CID
				const cid = `img-${Date.now()}-${Math.random().toString(36).slice(2)}@slate`;
				attachments = [...attachments, { filename: f.name || 'image.png', contentType: f.type, data, cid }];
				const blobUrl = URL.createObjectURL(new Blob([data as BlobPart], { type: f.type }));
				exec('insertHTML', `<img src="${blobUrl}" data-cid="${cid}" style="max-width:100%">`);
			} else {
				attachments = [...attachments, { filename: f.name, contentType: f.type || 'application/octet-stream', data }];
			}
		}
		dirty = true;
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
	}

	function onPaste(e: ClipboardEvent) {
		const files = Array.from(e.clipboardData?.files ?? []);
		if (files.length) {
			e.preventDefault();
			void addFiles(files);
		}
		dirty = true;
	}

	const totalAttSize = $derived(attachments.reduce((s, a) => s + a.data.length, 0));

	// ---- send ----
	async function send() {
		if (to.length === 0) { toasts.error('Add at least one recipient.'); return; }
		if (!identityId) { toasts.error('No sending identity configured.'); return; }

		let html = currentHtml();
		// attachment mention warning
		const bodyText = htmlToMarkdownish(html).toLowerCase();
		if (attachments.length === 0 && /\battach(ed|ment|ing)?\b/.test(bodyText)) {
			if (!confirm('You mention an attachment but nothing is attached. Send anyway?')) return;
		}
		// swap inline blob urls for cid: references
		html = html.replace(/<img([^>]*?)src="blob:[^"]*"([^>]*?)data-cid="([^"]+)"([^>]*?)>/g, '<img$1src="cid:$3"$2$4>')
			.replace(/<img([^>]*?)data-cid="([^"]+)"([^>]*?)src="blob:[^"]*"([^>]*?)>/g, '<img$1src="cid:$2"$3$4>');

		sending = true;
		try {
			const b64 = (u8: Uint8Array) => {
				let s = '';
				for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
				return btoa(s);
			};
			const res = await apiPost<{ ok: boolean; outboxId: number; sendAt: number }>('/api/mail', {
				action: 'send', profileId, identityId,
				to, cc, bcc, subject, html,
				attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, dataBase64: b64(a.data), cid: a.cid })),
				replyToMessageId: prefill.replyToMessageId,
				mode: prefill.mode ?? 'new'
			});
			if (draftId) void apiPost('/api/mail', { action: 'delete-draft', draftId }).catch(() => {});
			const delay = Math.max(0, res.sendAt - Date.now());
			if (delay > 1500) {
				toasts.undoable('Sending…', {
					durationMs: delay,
					undoLabel: 'Undo send',
					onUndo: async () => {
						const r = await apiPost<{ ok: boolean }>('/api/mail', { action: 'cancel-send', outboxId: res.outboxId });
						if (r.ok) toasts.show('Send cancelled');
						else toasts.error('Too late — already sent');
					}
				});
			} else {
				toasts.success('Sent');
			}
			onclose();
		} catch (e) {
			toasts.error(e instanceof Error ? e.message : 'Send failed');
		} finally {
			sending = false;
		}
	}

	function close() {
		if (dirty) void saveDraft();
		onclose();
	}
</script>

<div class="composer glass" class:minimized role="dialog" aria-label="Compose message"
	ondragover={(e) => { e.preventDefault(); dragOver = true; }}
	ondragleave={() => (dragOver = false)}
	ondrop={onDrop}
>
	<header class="comp-head">
		<span class="comp-title trunc">{subject || 'New message'}</span>
		{#if draftSavedAt}<span class="saved">Draft saved</span>{/if}
		<button class="head-btn" onclick={() => (minimized = !minimized)} aria-label={minimized ? 'Expand' : 'Minimize'}>{minimized ? '▲' : '▼'}</button>
		<button class="head-btn" onclick={close} aria-label="Close">✕</button>
	</header>

	{#if !minimized}
		<div class="comp-body" class:drag={dragOver}>
			{#if identities.length > 1}
				<div class="field-row">
					<span class="field-label">From</span>
					<select class="input from-sel" bind:value={identityId} onchange={() => (dirty = true)}>
						{#each identities as i (i.id)}
							<option value={i.id}>{i.name ? `${i.name} <${i.email}>` : i.email}{i.account_name ? ` — ${i.account_name}` : ''}</option>
						{/each}
					</select>
				</div>
			{/if}

			<div class="field-row chips-row">
				<span class="field-label">To</span>
				<div class="chips">
					{#each to as chip, i (chip.address)}
						<span class="chip" title={chip.address}>{chip.name || chip.address}<button onclick={() => removeChip('to', i)} aria-label="Remove">×</button></span>
					{/each}
					<input
						type="text" bind:value={toInput}
						onkeydown={(e) => onChipKeydown(e, 'to')}
						oninput={() => onChipInput('to')}
						onpaste={(e) => onPasteChips(e, 'to')}
						onblur={() => { setTimeout(() => { if (activeField === 'to') { commitChip('to'); suggestions = []; } }, 150); }}
						placeholder={to.length === 0 ? 'Recipients' : ''}
						aria-label="To recipients"
					/>
				</div>
				{#if !showCcBcc}
					<button class="ccbcc-btn" onclick={() => (showCcBcc = true)}>Cc/Bcc</button>
				{/if}
			</div>

			{#if showCcBcc}
				<div class="field-row chips-row">
					<span class="field-label">Cc</span>
					<div class="chips">
						{#each cc as chip, i (chip.address)}
							<span class="chip">{chip.name || chip.address}<button onclick={() => removeChip('cc', i)} aria-label="Remove">×</button></span>
						{/each}
						<input type="text" bind:value={ccInput} onkeydown={(e) => onChipKeydown(e, 'cc')} oninput={() => onChipInput('cc')} onpaste={(e) => onPasteChips(e, 'cc')} aria-label="Cc recipients" />
					</div>
				</div>
				<div class="field-row chips-row">
					<span class="field-label">Bcc</span>
					<div class="chips">
						{#each bcc as chip, i (chip.address)}
							<span class="chip">{chip.name || chip.address}<button onclick={() => removeChip('bcc', i)} aria-label="Remove">×</button></span>
						{/each}
						<input type="text" bind:value={bccInput} onkeydown={(e) => onChipKeydown(e, 'bcc')} oninput={() => onChipInput('bcc')} onpaste={(e) => onPasteChips(e, 'bcc')} aria-label="Bcc recipients" />
					</div>
				</div>
			{/if}

			{#if suggestions.length > 0 && activeField}
				<div class="suggestions glass" role="listbox" aria-label="Contact suggestions">
					{#each suggestions as s, i (s.address)}
						<button class="sug" class:sel={i === sugIdx} role="option" aria-selected={i === sugIdx} onmousedown={(e) => { e.preventDefault(); pickSuggestion(activeField!, s); }}>
							<strong>{s.name || s.address}</strong>
							{#if s.name}<span class="sug-addr">{s.address}</span>{/if}
						</button>
					{/each}
				</div>
			{/if}

			<div class="field-row">
				<input class="subject-input" type="text" bind:value={subject} oninput={() => (dirty = true)} placeholder="Subject" aria-label="Subject" />
			</div>

			<div class="toolbar" role="toolbar" aria-label="Formatting">
				{#if !markdownMode}
					<button onclick={() => exec('bold')} title="Bold (⌘B)"><b>B</b></button>
					<button onclick={() => exec('italic')} title="Italic (⌘I)"><i>I</i></button>
					<button onclick={() => exec('underline')} title="Underline (⌘U)"><u>U</u></button>
					<span class="tb-sep"></span>
					<button onclick={() => exec('formatBlock', 'h2')} title="Heading">H</button>
					<button onclick={() => exec('insertUnorderedList')} title="Bullet list">• –</button>
					<button onclick={() => exec('insertOrderedList')} title="Numbered list">1.</button>
					<button onclick={() => exec('formatBlock', 'blockquote')} title="Quote">❝</button>
					<button onclick={insertLink} title="Link">🔗</button>
					<button onclick={() => exec('removeFormat')} title="Clear formatting">⌫</button>
				{/if}
				<span class="tb-grow"></span>
				<button class:on={markdownMode} onclick={toggleMarkdown} title="Markdown mode">MD</button>
			</div>

			{#if markdownMode}
				<textarea class="md-editor" bind:value={markdownText} oninput={() => (dirty = true)} placeholder="Write markdown…" aria-label="Message body (markdown)"></textarea>
			{:else}
				<div
					class="editor"
					bind:this={editorEl}
					contenteditable="true"
					role="textbox"
					aria-multiline="true"
					aria-label="Message body"
					onkeydown={onEditorKeydown}
					onpaste={onPaste}
					oninput={() => (dirty = true)}
				></div>
			{/if}

			{#if attachments.length > 0}
				<div class="att-strip">
					{#each attachments as a, i (i)}
						<span class="att-chip" title={a.filename}>
							📎 <span class="trunc">{a.filename}</span>
							<span class="att-sz">{fmtBytes(a.data.length)}</span>
							<button onclick={() => { attachments = attachments.toSpliced(i, 1); dirty = true; }} aria-label="Remove attachment">×</button>
						</span>
					{/each}
					<span class="att-total">{fmtBytes(totalAttSize)} total</span>
				</div>
			{/if}

			<footer class="comp-foot">
				<button class="btn btn-primary send-btn" onclick={send} disabled={sending}>
					{sending ? 'Queuing…' : undoSendSeconds > 0 ? `Send` : 'Send now'}
				</button>
				<label class="btn attach-btn">
					📎 Attach
					<input type="file" multiple hidden onchange={(e) => { const f = (e.target as HTMLInputElement).files; if (f) void addFiles(f); (e.target as HTMLInputElement).value = ''; }} />
				</label>
				<span class="foot-spacer"></span>
				<button class="btn btn-ghost" onclick={close}>Discard to drafts</button>
			</footer>
		</div>
	{/if}
</div>

<style>
	.composer {
		position: fixed;
		bottom: 0; right: 24px;
		width: min(560px, calc(100vw - 32px));
		z-index: 800;
		border-radius: var(--r-4) var(--r-4) 0 0;
		box-shadow: var(--shadow-3);
		display: flex; flex-direction: column;
		max-height: min(80vh, 720px);
		animation: comp-in var(--dur-2) var(--ease-spring) both;
	}
	.composer.minimized { width: 280px; }
	.comp-head {
		display: flex; align-items: center; gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
		cursor: default;
	}
	.comp-title { flex: 1; min-width: 0; font-weight: 600; font-size: 13.5px; }
	.saved { font-size: 11px; color: var(--text-3); flex: none; }
	.head-btn { background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 12px; padding: 3px 6px; border-radius: var(--r-1); }
	.head-btn:hover { background: var(--surface-2); color: var(--text-1); }
	.comp-body { display: flex; flex-direction: column; overflow-y: auto; position: relative; }
	.comp-body.drag::after {
		content: 'Drop files to attach';
		position: absolute; inset: 6px;
		display: grid; place-items: center;
		background: color-mix(in oklab, var(--accent) 12%, var(--surface-0));
		border: 2px dashed var(--accent); border-radius: var(--r-3);
		font-weight: 600; color: var(--accent); z-index: 5;
	}
	.field-row {
		display: flex; align-items: center; gap: 8px;
		padding: 7px 14px;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
	}
	.field-label { font-size: 12.5px; color: var(--text-3); width: 34px; flex: none; }
	.from-sel { flex: 1; padding: 4px 8px; font-size: 13px; }
	.chips-row { flex-wrap: wrap; }
	.chips { flex: 1; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
	.chip {
		display: inline-flex; align-items: center; gap: 4px;
		background: var(--surface-2); border: 1px solid var(--border);
		border-radius: 99px; padding: 2px 4px 2px 10px;
		font-size: 12.5px; max-width: 220px;
	}
	.chip button { background: none; border: none; cursor: pointer; color: var(--text-3); font-size: 13px; padding: 0 4px; }
	.chip button:hover { color: var(--danger); }
	.chips input {
		flex: 1; min-width: 120px;
		background: none; border: none; outline: none;
		color: var(--text-1); font-size: 13.5px; font-family: inherit; padding: 3px 0;
	}
	.ccbcc-btn { background: none; border: none; color: var(--text-3); font-size: 12px; cursor: pointer; font-family: inherit; }
	.ccbcc-btn:hover { color: var(--accent); }
	.suggestions {
		position: absolute; left: 50px; right: 20px; z-index: 10;
		margin-top: -4px;
		border-radius: var(--r-2);
		box-shadow: var(--shadow-3);
		padding: 4px;
		max-height: 220px; overflow-y: auto;
	}
	.sug {
		display: flex; align-items: baseline; gap: 8px;
		width: 100%; text-align: left;
		background: none; border: none; cursor: pointer;
		padding: 7px 10px; border-radius: var(--r-1);
		font-family: inherit; font-size: 13px; color: var(--text-1);
	}
	.sug.sel, .sug:hover { background: color-mix(in oklab, var(--accent) 13%, transparent); }
	.sug-addr { color: var(--text-3); font-size: 12px; }
	.subject-input {
		flex: 1;
		background: none; border: none; outline: none;
		color: var(--text-1); font-size: 14px; font-weight: 560; font-family: inherit;
		padding: 2px 0;
	}
	.toolbar {
		display: flex; align-items: center; gap: 2px;
		padding: 6px 12px;
		border-bottom: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
	}
	.toolbar button {
		background: none; border: none; cursor: pointer;
		color: var(--text-2); font-size: 13px;
		min-width: 28px; height: 26px; border-radius: var(--r-1);
		font-family: inherit;
	}
	.toolbar button:hover { background: var(--surface-2); }
	.toolbar button.on { background: color-mix(in oklab, var(--accent) 16%, transparent); color: var(--accent); }
	.tb-sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }
	.tb-grow { flex: 1; }
	.editor, .md-editor {
		min-height: 180px; max-height: 380px;
		overflow-y: auto;
		padding: 12px 16px;
		outline: none;
		font-size: 14px; line-height: 1.55;
		color: var(--text-1);
	}
	.md-editor {
		background: none; border: none; resize: vertical;
		font-family: var(--font-mono, ui-monospace, monospace); font-size: 13px;
		width: 100%;
	}
	.editor :global(blockquote) {
		border-left: 3px solid var(--border);
		margin: 6px 0; padding: 2px 12px;
		color: var(--text-2);
	}
	.editor :global(pre) { background: var(--surface-2); border-radius: var(--r-1); padding: 8px 10px; overflow-x: auto; }
	.editor :global(h2), .editor :global(h3) { font-family: var(--font-display); margin: 10px 0 4px; }
	.att-strip {
		display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
		padding: 8px 14px;
		border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
	}
	.att-chip {
		display: inline-flex; align-items: center; gap: 6px;
		background: var(--surface-2); border: 1px solid var(--border);
		border-radius: var(--r-1); padding: 3px 8px;
		font-size: 12px; max-width: 240px;
	}
	.att-sz { color: var(--text-3); font-size: 11px; flex: none; }
	.att-chip button { background: none; border: none; cursor: pointer; color: var(--text-3); }
	.att-total { font-size: 11.5px; color: var(--text-3); margin-left: auto; }
	.comp-foot {
		display: flex; align-items: center; gap: 8px;
		padding: 10px 14px;
		border-top: 1px solid var(--border);
	}
	.send-btn { padding: 7px 22px; }
	.attach-btn { cursor: pointer; }
	.foot-spacer { flex: 1; }
	.trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	@keyframes comp-in { from { opacity: 0; transform: translateY(24px); } }
	@media (max-width: 640px) {
		.composer { right: 0; left: 0; width: 100%; max-height: 92vh; border-radius: var(--r-3) var(--r-3) 0 0; }
	}
	@media (prefers-reduced-motion: reduce) { .composer { animation: none; } }
</style>
