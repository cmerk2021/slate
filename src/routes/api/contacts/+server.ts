import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { parseVcard } from '$lib/server/dav/vcard';
import { createContact, updateContact, deleteContact } from '$lib/server/dav/ops';
import { syncAddressbooks } from '$lib/server/dav/sync';

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const db = getDb();
	const profileId = parseInt(url.searchParams.get('profile') ?? '0', 10);
	const view = url.searchParams.get('view') ?? 'list';

	if (view === 'books') {
		const books = db.prepare(`SELECT b.id, b.name, a.name account_name FROM addressbooks b JOIN accounts a ON a.id = b.account_id
			WHERE a.profile_id = ? ORDER BY b.id`).all(profileId);
		return json({ books });
	}

	if (view === 'detail') {
		const id = parseInt(url.searchParams.get('id') ?? '0', 10);
		const row = db.prepare(`SELECT c.*, b.name book_name FROM contacts c JOIN addressbooks b ON b.id = c.addressbook_id
			JOIN accounts a ON a.id = b.account_id WHERE c.id = ? AND a.profile_id = ?`).get(id, profileId) as { vcard: string; id: number; addressbook_id: number; book_name: string } | undefined;
		if (!row) throw error(404, 'Contact not found');
		const parsed = parseVcard(row.vcard);
		return json({ contact: { id: row.id, addressbookId: row.addressbook_id, bookName: row.book_name, ...parsed } });
	}

	if (view === 'autocomplete') {
		const q = (url.searchParams.get('q') ?? '').toLowerCase();
		const contacts = db.prepare(`SELECT c.fn, c.emails_json FROM contacts c JOIN addressbooks b ON b.id = c.addressbook_id
			JOIN accounts a ON a.id = b.account_id WHERE a.profile_id = ? AND (LOWER(c.fn) LIKE ? OR LOWER(c.emails_json) LIKE ?) LIMIT 8`)
			.all(profileId, `%${q}%`, `%${q}%`) as { fn: string; emails_json: string }[];
		const results: { name: string; address: string }[] = [];
		for (const c of contacts) {
			for (const e of JSON.parse(c.emails_json) as { value: string }[]) {
				if (e.value) results.push({ name: c.fn, address: e.value });
			}
		}
		// recently used addresses from sent mail
		const recents = db.prepare(`SELECT DISTINCT m.to_json FROM messages m JOIN folders f ON f.id = m.folder_id AND f.role = 'sent'
			JOIN accounts a ON a.id = m.account_id WHERE a.profile_id = ? ORDER BY m.internal_date DESC LIMIT 50`).all(profileId) as { to_json: string }[];
		for (const r of recents) {
			for (const a of JSON.parse(r.to_json) as { name: string; address: string }[]) {
				if (a.address && (a.address.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))) {
					if (!results.some((x) => x.address.toLowerCase() === a.address.toLowerCase())) results.push(a);
				}
			}
		}
		return json({ results: results.slice(0, 8) });
	}

	// list
	const contacts = db.prepare(`SELECT c.id, c.addressbook_id, c.fn, c.emails_json, c.phones_json, c.org, c.photo FROM contacts c
		JOIN addressbooks b ON b.id = c.addressbook_id JOIN accounts a ON a.id = b.account_id
		WHERE a.profile_id = ? ORDER BY c.fn COLLATE NOCASE`).all(profileId) as
		{ id: number; addressbook_id: number; fn: string; emails_json: string; phones_json: string; org: string | null; photo: string | null }[];
	return json({
		contacts: contacts.map((c) => ({
			id: c.id,
			addressbookId: c.addressbook_id,
			fn: c.fn,
			emails: JSON.parse(c.emails_json),
			phones: JSON.parse(c.phones_json),
			org: c.org,
			photo: c.photo
		}))
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.session) throw error(401, 'Unauthorized');
	const body = await request.json();
	const db = getDb();

	try {
		switch (body.action) {
			case 'create': {
				const { uid } = await createContact(body.addressbookId, body.contact);
				return json({ ok: true, uid });
			}
			case 'update': {
				await updateContact(body.contactId, body.contact);
				return json({ ok: true });
			}
			case 'delete': {
				await deleteContact(body.contactId);
				return json({ ok: true });
			}
			case 'merge': {
				// merge: update primary with merged fields, delete secondary
				await updateContact(body.primaryId, body.contact);
				await deleteContact(body.secondaryId);
				return json({ ok: true });
			}
			case 'sync': {
				const accounts = db.prepare("SELECT id FROM accounts WHERE profile_id = ? AND kind = 'carddav'").all(body.profileId) as { id: number }[];
				for (const a of accounts) await syncAddressbooks(a.id);
				return json({ ok: true });
			}
			default:
				throw error(400, 'Unknown action');
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		return json({ ok: false, error: err instanceof Error ? err.message : 'Contact action failed' }, { status: 500 });
	}
};
