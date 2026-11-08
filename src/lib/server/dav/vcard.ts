import ICAL from 'ical.js';

/** vCard 3.0/4.0 parsing and building. Unit tested. */

export interface ContactData {
	uid: string;
	fn: string;
	firstName: string;
	lastName: string;
	emails: { type: string; value: string }[];
	phones: { type: string; value: string }[];
	addresses: { type: string; value: string }[];
	org: string;
	title: string;
	bday: string;
	note: string;
	photo: string | null; // data: URL
	groups: string[];
}

export function parseVcard(vcardText: string): ContactData | null {
	try {
		const jcard = ICAL.parse(vcardText);
		const comp = new ICAL.Component(jcard);
		const n = comp.getFirstPropertyValue('n');
		const nParts = Array.isArray(n) ? (n as string[]) : ['', ''];
		const typed = (name: string) =>
			comp.getAllProperties(name).map((p) => ({
				type: String(p.getParameter('type') ?? 'other').toLowerCase().split(',')[0],
				value: String(p.getFirstValue() ?? '')
			}));
		const adrs = comp.getAllProperties('adr').map((p) => {
			const v = p.getFirstValue();
			const parts = Array.isArray(v) ? (v as string[]).filter(Boolean) : [String(v ?? '')];
			return { type: String(p.getParameter('type') ?? 'other').toLowerCase().split(',')[0], value: parts.join(', ') };
		});
		let photo: string | null = null;
		const photoProp = comp.getFirstProperty('photo');
		if (photoProp) {
			const v = String(photoProp.getFirstValue() ?? '');
			if (v.startsWith('data:') || v.startsWith('http')) photo = v;
			else if (v.length > 50) {
				const mediatype = (photoProp.getParameter('mediatype') as string) || (photoProp.getParameter('type') ? `image/${String(photoProp.getParameter('type')).toLowerCase()}` : 'image/jpeg');
				photo = `data:${mediatype};base64,${v.replace(/\s/g, '')}`;
			}
		}
		const org = comp.getFirstPropertyValue('org');
		const categories = comp.getFirstPropertyValue('categories');
		return {
			uid: String(comp.getFirstPropertyValue('uid') ?? ''),
			fn: String(comp.getFirstPropertyValue('fn') ?? ''),
			lastName: nParts[0] ?? '',
			firstName: nParts[1] ?? '',
			emails: typed('email'),
			phones: typed('tel'),
			addresses: adrs,
			org: Array.isArray(org) ? (org as string[]).join(' ') : String(org ?? ''),
			title: String(comp.getFirstPropertyValue('title') ?? ''),
			bday: String(comp.getFirstPropertyValue('bday') ?? ''),
			note: String(comp.getFirstPropertyValue('note') ?? ''),
			photo,
			groups: Array.isArray(categories) ? (categories as string[]) : categories ? [String(categories)] : []
		};
	} catch {
		return null;
	}
}

export interface ContactInput {
	uid?: string;
	firstName: string;
	lastName: string;
	emails?: { type: string; value: string }[];
	phones?: { type: string; value: string }[];
	addresses?: { type: string; value: string }[];
	org?: string;
	title?: string;
	bday?: string;
	note?: string;
	photo?: string | null;
	groups?: string[];
}

export function buildVcard(input: ContactInput): { vcard: string; uid: string } {
	const uid = input.uid ?? crypto.randomUUID();
	const comp = new ICAL.Component(['vcard', [], []]);
	comp.updatePropertyWithValue('version', '3.0');
	comp.updatePropertyWithValue('uid', uid);
	const fn = `${input.firstName} ${input.lastName}`.trim() || input.emails?.[0]?.value || 'Unnamed';
	comp.updatePropertyWithValue('fn', fn);
	const nProp = new ICAL.Property('n', comp);
	nProp.setValue([input.lastName, input.firstName, '', '', '']);
	comp.addProperty(nProp);
	for (const e of input.emails ?? []) {
		if (!e.value) continue;
		const p = new ICAL.Property('email', comp);
		p.setValue(e.value);
		p.setParameter('type', e.type.toUpperCase());
		comp.addProperty(p);
	}
	for (const t of input.phones ?? []) {
		if (!t.value) continue;
		const p = new ICAL.Property('tel', comp);
		p.setValue(t.value);
		p.setParameter('type', t.type.toUpperCase());
		comp.addProperty(p);
	}
	for (const a of input.addresses ?? []) {
		if (!a.value) continue;
		const p = new ICAL.Property('adr', comp);
		p.setValue(['', '', a.value, '', '', '', '']);
		p.setParameter('type', a.type.toUpperCase());
		comp.addProperty(p);
	}
	if (input.org) comp.updatePropertyWithValue('org', input.org);
	if (input.title) comp.updatePropertyWithValue('title', input.title);
	if (input.bday) comp.updatePropertyWithValue('bday', input.bday);
	if (input.note) comp.updatePropertyWithValue('note', input.note);
	if (input.photo?.startsWith('data:')) {
		const m = input.photo.match(/^data:(image\/[a-z+]+);base64,(.*)$/s);
		if (m) {
			const p = new ICAL.Property('photo', comp);
			p.setValue(m[2]);
			p.setParameter('encoding', 'b');
			p.setParameter('type', m[1].split('/')[1].toUpperCase());
			comp.addProperty(p);
		}
	}
	if (input.groups && input.groups.length > 0) {
		comp.updatePropertyWithValue('categories', input.groups.join(','));
	}
	return { vcard: comp.toString(), uid };
}
