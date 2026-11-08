import sanitizeHtml from 'sanitize-html';

export interface SanitizeResult {
	html: string;
	remoteImages: number;
	trackersBlocked: number;
}

const TRACKER_DOMAINS = [
	'list-manage.com', 'mailchimp.com', 'sendgrid.net', 'mailgun.org', 'mandrillapp.com',
	'constantcontact.com', 'exacttarget.com', 'getresponse.com', 'mixpanel.com',
	'doubleclick.net', 'google-analytics.com', 'litmus.com', 'mailtrack.io', 'sendibm1.com',
	'klaviyomail.com', 'braze.com', 'customeriomail.com', 'hubspotemail.net'
];

const TRACKING_PARAMS = [
	'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
	'mc_cid', 'mc_eid', 'fbclid', 'gclid', 'igshid', 'vero_id', 'mkt_tok', '_hsenc', '_hsmi'
];

export function stripTrackingParams(href: string): string {
	try {
		const u = new URL(href);
		let changed = false;
		for (const p of TRACKING_PARAMS) {
			if (u.searchParams.has(p)) {
				u.searchParams.delete(p);
				changed = true;
			}
		}
		return changed ? u.toString() : href;
	} catch {
		return href;
	}
}

function isTrackerPixel(attribs: Record<string, string>): boolean {
	const w = parseInt(attribs.width ?? '', 10);
	const h = parseInt(attribs.height ?? '', 10);
	if ((w === 1 && h === 1) || (w === 0 && h === 0)) return true;
	const style = attribs.style ?? '';
	if (/display:\s*none|width:\s*1px|height:\s*1px/i.test(style)) return true;
	const src = attribs.src ?? '';
	try {
		const host = new URL(src).hostname;
		if (TRACKER_DOMAINS.some((d) => host === d || host.endsWith('.' + d)) && /track|open|pixel|beacon|\.gif(\?|$)/i.test(src)) return true;
	} catch { /* relative/cid */ }
	return false;
}

/**
 * Sanitize an HTML email body for rendering inside a sandboxed iframe.
 * - no scripts/forms/embeds, no dangerous CSS, no external stylesheets
 * - remote images are rewritten to the proxy when allowed, or stripped when not
 * - cid: images are rewritten to the attachment endpoint
 */
export function sanitizeEmailHtml(
	html: string,
	opts: {
		allowRemote: boolean;
		proxyBase?: string; // e.g. /api/proxy/image?url=
		cidResolver?: (cid: string) => string | null;
	}
): SanitizeResult {
	let remoteImages = 0;
	let trackersBlocked = 0;

	const clean = sanitizeHtml(html, {
		allowedTags: [
			'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption',
			'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt',
			'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
			'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q',
			'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong', 'sub',
			'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr'
		],
		allowedAttributes: {
			'*': ['style', 'align', 'valign', 'width', 'height', 'dir', 'lang', 'border', 'cellpadding', 'cellspacing', 'bgcolor', 'color'],
			a: ['href', 'name', 'target', 'style'],
			img: ['src', 'alt', 'width', 'height', 'style'],
			font: ['color', 'size', 'face'],
			td: ['colspan', 'rowspan', 'style', 'align', 'valign', 'width', 'height', 'bgcolor'],
			th: ['colspan', 'rowspan', 'style', 'align', 'valign', 'width', 'height', 'bgcolor']
		},
		allowedSchemes: ['https', 'http', 'mailto', 'tel', 'cid', 'data'],
		allowedSchemesByTag: { img: ['https', 'http', 'cid', 'data'] },
		allowProtocolRelative: false,
		parseStyleAttributes: false,
		transformTags: {
			a: (tagName, attribs) => {
				const href = attribs.href ? stripTrackingParams(attribs.href) : undefined;
				return {
					tagName,
					attribs: {
						...attribs,
						...(href ? { href } : {}),
						target: '_blank',
						rel: 'noopener noreferrer'
					}
				};
			},
			img: (tagName, attribs) => {
				const src = attribs.src ?? '';
				if (src.startsWith('cid:')) {
					const resolved = opts.cidResolver?.(src.slice(4));
					if (resolved) return { tagName, attribs: { ...attribs, src: resolved } };
					return { tagName: 'span', attribs: {}, text: '' };
				}
				if (src.startsWith('data:image/')) {
					return { tagName, attribs };
				}
				if (/^https?:/i.test(src)) {
					if (isTrackerPixel(attribs)) {
						trackersBlocked++;
						return { tagName: 'span', attribs: {}, text: '' };
					}
					remoteImages++;
					if (opts.allowRemote && opts.proxyBase) {
						return { tagName, attribs: { ...attribs, src: opts.proxyBase + encodeURIComponent(src), loading: 'lazy' } };
					}
					return {
						tagName: 'img',
						attribs: { alt: attribs.alt ?? '', 'data-blocked-src': src, style: 'display:none' }
					};
				}
				return { tagName: 'span', attribs: {}, text: '' };
			}
		}
	});

	// scrub dangerous CSS from inline styles (position fixed/sticky, imports, external url())
	const scrubbed = clean.replace(/style\s*=\s*"([^"]*)"/gi, (_m, css: string) => {
		let s = css
			.replace(/position\s*:\s*(fixed|sticky)/gi, 'position:static')
			.replace(/@import[^;]*/gi, '')
			.replace(/expression\s*\([^)]*\)/gi, '');
		// url() in styles: only allow data: images
		s = s.replace(/url\s*\(\s*(['"]?)(?!data:)[^)]*\1\s*\)/gi, 'none');
		return `style="${s}"`;
	});

	return { html: scrubbed, remoteImages, trackersBlocked };
}

/** Wrap a sanitized email body into a complete srcdoc document with base typography. */
export function wrapEmailDocument(bodyHtml: string, opts: { dark: boolean; adaptDark: boolean }): string {
	const darkCss = opts.dark && opts.adaptDark
		? `
		:root { color-scheme: dark; }
		body { background: #1d1a17 !important; color: #e8e2da !important; }
		body :where(div,td,th,table,p,span,li,ul,ol,blockquote,section,article,h1,h2,h3,h4,h5,h6,center,font) {
			background-color: transparent !important;
			border-color: #44403a !important;
			color: inherit !important;
		}
		a { color: #f2a37c !important; }
		img { opacity: 0.92; }
	`
		: opts.dark
			? ':root { color-scheme: dark; } body { background: #ffffff; color: #111; }'
			: ':root { color-scheme: light; } body { background: #ffffff; color: #111; }';
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>
	body { margin: 0; padding: 16px; font-family: 'Instrument Sans', system-ui, -apple-system, sans-serif; font-size: 14.5px; line-height: 1.6; word-wrap: break-word; overflow-wrap: break-word; }
	img { max-width: 100%; height: auto; }
	table { max-width: 100%; }
	pre { white-space: pre-wrap; }
	blockquote { border-left: 3px solid #8884; margin: 8px 0; padding-left: 12px; color: inherit; opacity: 0.85; }
	${darkCss}
	</style></head><body>${bodyHtml}</body></html>`;
}
