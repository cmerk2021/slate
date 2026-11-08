import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml, stripTrackingParams } from './sanitize';

describe('sanitizeEmailHtml', () => {
	it('strips scripts and event handlers', () => {
		const r = sanitizeEmailHtml('<p onclick="alert(1)">hi</p><script>alert(2)</script>', { allowRemote: false });
		expect(r.html).not.toContain('script');
		expect(r.html).not.toContain('onclick');
		expect(r.html).toContain('hi');
	});

	it('strips forms, iframes, and embeds', () => {
		const r = sanitizeEmailHtml('<form action="x"><input></form><iframe src="x"></iframe><object data="x"></object>ok', { allowRemote: false });
		expect(r.html).not.toContain('<form');
		expect(r.html).not.toContain('<iframe');
		expect(r.html).not.toContain('<object');
		expect(r.html).toContain('ok');
	});

	it('blocks remote images by default and counts them', () => {
		const r = sanitizeEmailHtml('<img src="https://example.com/a.png" width="300" height="100">', { allowRemote: false });
		expect(r.html).not.toContain('https://example.com/a.png');
		expect(r.remoteImages).toBe(1);
	});

	it('proxies remote images when allowed', () => {
		const r = sanitizeEmailHtml('<img src="https://example.com/a.png" width="300" height="100">', {
			allowRemote: true,
			proxyBase: '/api/proxy/image?url='
		});
		expect(r.html).toContain('/api/proxy/image?url=' + encodeURIComponent('https://example.com/a.png'));
	});

	it('strips 1x1 tracking pixels even when images are allowed', () => {
		const r = sanitizeEmailHtml('<img src="https://tracker.example/o.gif" width="1" height="1">', {
			allowRemote: true,
			proxyBase: '/api/proxy/image?url='
		});
		expect(r.html).not.toContain('tracker.example');
		expect(r.trackersBlocked).toBe(1);
	});

	it('resolves cid: images', () => {
		const r = sanitizeEmailHtml('<img src="cid:logo@x">', {
			allowRemote: false,
			cidResolver: (cid) => `/api/mail?view=attachment&cid=${encodeURIComponent(cid)}`
		});
		expect(r.html).toContain('cid=logo%40x');
	});

	it('removes dangerous CSS', () => {
		const r = sanitizeEmailHtml('<div style="position:fixed;top:0;color:red">x</div>', { allowRemote: false });
		expect(r.html).not.toMatch(/position:\s*fixed/i);
	});

	it('keeps javascript: out of hrefs', () => {
		const r = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>', { allowRemote: false });
		expect(r.html).not.toContain('javascript:');
	});
});

describe('stripTrackingParams', () => {
	it('removes utm and click ids', () => {
		const out = stripTrackingParams('https://example.com/page?utm_source=nl&utm_campaign=x&id=5&fbclid=abc');
		expect(out).toContain('id=5');
		expect(out).not.toContain('utm_source');
		expect(out).not.toContain('fbclid');
	});
	it('leaves clean urls alone', () => {
		expect(stripTrackingParams('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
	});
	it('ignores invalid urls', () => {
		expect(stripTrackingParams('not a url')).toBe('not a url');
	});
});
