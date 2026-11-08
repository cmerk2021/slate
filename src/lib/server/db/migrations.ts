export interface Migration {
	version: number;
	sql: string;
}

export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	ip TEXT,
	user_agent TEXT
);

CREATE TABLE passkeys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	public_key BLOB NOT NULL,
	counter INTEGER NOT NULL DEFAULT 0,
	transports TEXT,
	created_at INTEGER NOT NULL,
	last_used INTEGER
);

CREATE TABLE rate_limits (
	key TEXT PRIMARY KEY,
	fails INTEGER NOT NULL DEFAULT 0,
	locked_until INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL
);

CREATE TABLE profiles (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	icon TEXT NOT NULL DEFAULT '🏠',
	accent_h INTEGER,
	theme TEXT,
	sort_order INTEGER NOT NULL DEFAULT 0,
	settings TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE accounts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	kind TEXT NOT NULL, -- imap | pop3 | caldav | carddav
	name TEXT NOT NULL,
	email TEXT,
	imap_host TEXT, imap_port INTEGER, imap_security TEXT,
	smtp_host TEXT, smtp_port INTEGER, smtp_security TEXT,
	dav_url TEXT,
	username TEXT,
	secret_enc BLOB,
	allow_self_signed INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	settings TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_accounts_profile ON accounts(profile_id);

CREATE TABLE identities (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	email TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	signature_html TEXT NOT NULL DEFAULT '',
	is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_identities_account ON identities(account_id);

CREATE TABLE folders (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	name TEXT NOT NULL,
	delimiter TEXT,
	parent_path TEXT,
	role TEXT, -- inbox|sent|drafts|trash|junk|archive|snoozed
	uidvalidity INTEGER,
	uidnext INTEGER,
	highestmodseq TEXT,
	total INTEGER NOT NULL DEFAULT 0,
	unseen INTEGER NOT NULL DEFAULT 0,
	watched INTEGER NOT NULL DEFAULT 0,
	sort_order INTEGER NOT NULL DEFAULT 0,
	UNIQUE(account_id, path)
);

CREATE TABLE messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
	uid INTEGER NOT NULL,
	message_id TEXT,
	in_reply_to TEXT,
	refs TEXT,
	thread_key TEXT,
	subject TEXT NOT NULL DEFAULT '',
	from_json TEXT NOT NULL DEFAULT '[]',
	to_json TEXT NOT NULL DEFAULT '[]',
	cc_json TEXT NOT NULL DEFAULT '[]',
	reply_to_json TEXT NOT NULL DEFAULT '[]',
	date INTEGER,
	internal_date INTEGER,
	seen INTEGER NOT NULL DEFAULT 0,
	flagged INTEGER NOT NULL DEFAULT 0,
	answered INTEGER NOT NULL DEFAULT 0,
	draft INTEGER NOT NULL DEFAULT 0,
	flags_json TEXT NOT NULL DEFAULT '[]',
	size INTEGER NOT NULL DEFAULT 0,
	snippet TEXT NOT NULL DEFAULT '',
	has_attachments INTEGER NOT NULL DEFAULT 0,
	list_id TEXT,
	list_unsubscribe TEXT,
	list_unsubscribe_post TEXT,
	snoozed_until INTEGER,
	snooze_orig_folder INTEGER,
	body_indexed INTEGER NOT NULL DEFAULT 0,
	UNIQUE(folder_id, uid)
);
CREATE INDEX idx_messages_folder_date ON messages(folder_id, internal_date DESC);
CREATE INDEX idx_messages_account_date ON messages(account_id, internal_date DESC);
CREATE INDEX idx_messages_thread ON messages(account_id, thread_key);
CREATE INDEX idx_messages_msgid ON messages(message_id);
CREATE INDEX idx_messages_snoozed ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX idx_messages_unseen ON messages(folder_id, seen, internal_date DESC);

CREATE VIRTUAL TABLE message_fts USING fts5(
	subject, from_addr, to_addr, body,
	content='', contentless_delete=1
);

CREATE TABLE cache_blobs (
	key TEXT PRIMARY KEY,
	size INTEGER NOT NULL,
	last_used INTEGER NOT NULL
);

CREATE TABLE outbox (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	profile_id INTEGER NOT NULL,
	mime BLOB NOT NULL,
	envelope_json TEXT NOT NULL,
	send_at INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'queued', -- queued|sending|sent|cancelled|failed
	error TEXT,
	created_at INTEGER NOT NULL,
	meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_outbox_due ON outbox(status, send_at);

CREATE TABLE drafts_local (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	draft_uid INTEGER,
	data_json TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE addressbooks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	name TEXT NOT NULL,
	sync_token TEXT,
	ctag TEXT,
	UNIQUE(account_id, url)
);

CREATE TABLE contacts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	addressbook_id INTEGER NOT NULL REFERENCES addressbooks(id) ON DELETE CASCADE,
	href TEXT NOT NULL,
	etag TEXT,
	uid TEXT,
	fn TEXT NOT NULL DEFAULT '',
	emails_json TEXT NOT NULL DEFAULT '[]',
	phones_json TEXT NOT NULL DEFAULT '[]',
	org TEXT,
	bday TEXT,
	note TEXT,
	photo TEXT,
	vcard TEXT NOT NULL,
	UNIQUE(addressbook_id, href)
);
CREATE INDEX idx_contacts_fn ON contacts(fn);

CREATE TABLE calendars (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	name TEXT NOT NULL,
	color TEXT,
	visible INTEGER NOT NULL DEFAULT 1,
	is_default INTEGER NOT NULL DEFAULT 0,
	supports_vevent INTEGER NOT NULL DEFAULT 1,
	supports_vtodo INTEGER NOT NULL DEFAULT 0,
	sync_token TEXT,
	ctag TEXT,
	UNIQUE(account_id, url)
);

CREATE TABLE cal_objects (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
	href TEXT NOT NULL,
	etag TEXT,
	uid TEXT,
	kind TEXT NOT NULL, -- vevent | vtodo
	summary TEXT NOT NULL DEFAULT '',
	dtstart INTEGER,
	dtend INTEGER,
	all_day INTEGER NOT NULL DEFAULT 0,
	has_rrule INTEGER NOT NULL DEFAULT 0,
	due INTEGER,
	completed INTEGER NOT NULL DEFAULT 0,
	status TEXT,
	priority INTEGER,
	parent_uid TEXT,
	ics TEXT NOT NULL,
	UNIQUE(calendar_id, href)
);
CREATE INDEX idx_cal_objects_range ON cal_objects(calendar_id, kind, dtstart, dtend);
CREATE INDEX idx_cal_objects_due ON cal_objects(calendar_id, kind, due);

CREATE TABLE trusted_senders (
	profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	sender TEXT NOT NULL, -- email or @domain
	PRIMARY KEY (profile_id, sender)
);

CREATE TABLE splits (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	rules_json TEXT NOT NULL DEFAULT '[]',
	sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE saved_searches (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	query TEXT NOT NULL
);

CREATE TABLE webauthn_challenges (
	id TEXT PRIMARY KEY,
	challenge TEXT NOT NULL,
	kind TEXT NOT NULL, -- registration | authentication
	created_at INTEGER NOT NULL
);
`
	}
];
