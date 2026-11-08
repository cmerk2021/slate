import type { Address } from './types';

/** Pure reply/forward computation logic — unit tested. */

const REPLY_PREFIX = /^(re|aw|sv|vs|antw|odp)(\[\d+\])?:\s*/i;
const FWD_PREFIX = /^(fwd?|wg|tr|vl|doorst)(\[\d+\])?:\s*/i;

export function replySubject(subject: string): string {
	let s = subject.trim();
	while (FWD_PREFIX.test(s) || REPLY_PREFIX.test(s)) {
		// strip only the outermost reply prefixes; keep inner Fwd context once we add Re:
		if (REPLY_PREFIX.test(s)) s = s.replace(REPLY_PREFIX, '');
		else break;
	}
	return 'Re: ' + s;
}

export function forwardSubject(subject: string): string {
	let s = subject.trim();
	if (FWD_PREFIX.test(s)) return s.replace(FWD_PREFIX, 'Fwd: ');
	return 'Fwd: ' + s;
}

export interface ReplyInput {
	from: Address[];
	to: Address[];
	cc: Address[];
	replyTo: Address[];
	/** Mail-Followup-To header addresses, if present */
	mailFollowupTo?: Address[];
	messageId: string | null;
	references: string | null;
	/** all addresses belonging to the user (identities) */
	ownAddresses: string[];
}

export interface ReplyRecipients {
	to: Address[];
	cc: Address[];
	inReplyTo: string | null;
	references: string;
}

function norm(a: string): string {
	return a.trim().toLowerCase();
}

function dedupe(list: Address[], exclude: Set<string>): Address[] {
	const seen = new Set<string>();
	const out: Address[] = [];
	for (const a of list) {
		const key = norm(a.address);
		if (!key || seen.has(key) || exclude.has(key)) continue;
		seen.add(key);
		out.push(a);
	}
	return out;
}

export function computeReferences(references: string | null, messageId: string | null): string {
	const refs: string[] = (references ?? '').match(/<[^>]+>/g) ?? [];
	if (messageId) {
		const mid = messageId.match(/<[^>]+>/)?.[0] ?? messageId;
		if (!refs.includes(mid)) refs.push(mid);
	}
	// RFC 5322 suggests trimming middle refs when overly long; keep first + last 9
	const trimmed = refs.length > 10 ? [refs[0], ...refs.slice(-9)] : refs;
	return trimmed.join(' ');
}

export function computeReply(input: ReplyInput, mode: 'reply' | 'replyAll'): ReplyRecipients {
	const own = new Set(input.ownAddresses.map(norm));
	const senders = input.replyTo.length > 0 ? input.replyTo : input.from;

	let to: Address[];
	let cc: Address[] = [];

	if (mode === 'reply') {
		to = dedupe(senders, new Set());
		// replying to your own message (e.g. in Sent): target the original recipients
		if (to.every((a) => own.has(norm(a.address))) && input.to.length > 0) {
			to = dedupe(input.to, own);
		}
	} else {
		if (input.mailFollowupTo && input.mailFollowupTo.length > 0) {
			to = dedupe(input.mailFollowupTo, own);
		} else {
			to = dedupe([...senders, ...input.to], own);
			cc = dedupe(input.cc, new Set([...own, ...to.map((a) => norm(a.address))]));
		}
		if (to.length === 0 && input.to.length > 0) to = dedupe(input.to, new Set());
	}
	if (to.length === 0) to = dedupe(senders, new Set());

	return {
		to,
		cc,
		inReplyTo: input.messageId,
		references: computeReferences(input.references, input.messageId)
	};
}

export function attributionLine(from: Address[], date: Date): string {
	const who = from[0] ? (from[0].name ? `${from[0].name} <${from[0].address}>` : from[0].address) : 'someone';
	return `On ${date.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, ${who} wrote:`;
}

export function quoteHtml(html: string, attribution: string): string {
	return `<p>${escapeHtml(attribution)}</p><blockquote type="cite" style="border-left:3px solid #ccc;margin:8px 0;padding-left:12px">${html}</blockquote>`;
}

export function quoteText(text: string, attribution: string): string {
	return attribution + '\n' + text.split('\n').map((l) => '> ' + l).join('\n');
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Minimal, decent HTML→plaintext for the text/plain alternative. */
export function htmlToPlainText(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<blockquote[^>]*>/gi, '\n')
		.replace(/<\/blockquote>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
		.replace(/<li[^>]*>/gi, '- ')
		.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
			const t = text.replace(/<[^>]+>/g, '').trim();
			return t && t !== href ? `${t} (${href})` : href;
		})
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
