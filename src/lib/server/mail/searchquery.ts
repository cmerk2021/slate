/** Search query parser: `from:` `to:` `subject:` `has:attachment` `is:unread` `is:starred` `in:folder` `before:` `after:` + free text. Unit tested. */

export interface ParsedQuery {
	text: string;
	from?: string;
	to?: string;
	subject?: string;
	hasAttachment?: boolean;
	unread?: boolean;
	starred?: boolean;
	inFolder?: string;
	before?: Date;
	after?: Date;
}

const OP_RE = /(-?)(from|to|subject|has|is|in|before|after):(?:"([^"]*)"|(\S+))/gi;

export function parseSearchQuery(q: string): ParsedQuery {
	const out: ParsedQuery = { text: '' };
	const rest = q.replace(OP_RE, (_m, _neg, op: string, quoted: string | undefined, bare: string | undefined) => {
		const val = (quoted ?? bare ?? '').trim();
		switch (op.toLowerCase()) {
			case 'from': out.from = val; break;
			case 'to': out.to = val; break;
			case 'subject': out.subject = val; break;
			case 'has': if (val.toLowerCase() === 'attachment') out.hasAttachment = true; break;
			case 'is':
				if (val.toLowerCase() === 'unread') out.unread = true;
				else if (val.toLowerCase() === 'read') out.unread = false;
				else if (val.toLowerCase() === 'starred' || val.toLowerCase() === 'flagged') out.starred = true;
				break;
			case 'in': out.inFolder = val; break;
			case 'before': { const d = parseDate(val); if (d) out.before = d; break; }
			case 'after': { const d = parseDate(val); if (d) out.after = d; break; }
		}
		return '';
	});
	out.text = rest.replace(/\s+/g, ' ').trim();
	return out;
}

function parseDate(v: string): Date | null {
	const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
	const m2 = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (m2) return new Date(Date.UTC(+m2[3], +m2[1] - 1, +m2[2]));
	const d = new Date(v);
	return isNaN(d.getTime()) ? null : d;
}

/** Escape a string for use inside an FTS5 MATCH expression (phrase quoting). */
export function ftsQuote(text: string): string {
	const terms = text.split(/\s+/).filter(Boolean);
	return terms.map((t) => '"' + t.replace(/"/g, '""') + '"*').join(' ');
}
