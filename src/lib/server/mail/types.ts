export interface Address {
	name: string;
	address: string;
}

export interface MessageRow {
	id: number;
	account_id: number;
	folder_id: number;
	uid: number;
	message_id: string | null;
	in_reply_to: string | null;
	refs: string | null;
	thread_key: string | null;
	subject: string;
	from_json: string;
	to_json: string;
	cc_json: string;
	reply_to_json: string;
	date: number | null;
	internal_date: number | null;
	seen: number;
	flagged: number;
	answered: number;
	draft: number;
	flags_json: string;
	size: number;
	snippet: string;
	has_attachments: number;
	list_id: string | null;
	list_unsubscribe: string | null;
	list_unsubscribe_post: string | null;
	snoozed_until: number | null;
	snooze_orig_folder: number | null;
}

export interface FolderRow {
	id: number;
	account_id: number;
	path: string;
	name: string;
	delimiter: string | null;
	parent_path: string | null;
	role: string | null;
	uidvalidity: number | null;
	uidnext: number | null;
	highestmodseq: string | null;
	total: number;
	unseen: number;
	watched: number;
	sort_order: number;
}

export interface AccountRow {
	id: number;
	profile_id: number;
	kind: 'imap' | 'pop3' | 'caldav' | 'carddav';
	name: string;
	email: string | null;
	imap_host: string | null;
	imap_port: number | null;
	imap_security: string | null;
	smtp_host: string | null;
	smtp_port: number | null;
	smtp_security: string | null;
	dav_url: string | null;
	username: string | null;
	secret_enc: Buffer | null;
	allow_self_signed: number;
	created_at: number;
	settings: string;
}

export interface MessageListItem {
	id: number;
	accountId: number;
	folderId: number;
	uid: number;
	subject: string;
	from: Address[];
	to: Address[];
	date: number;
	seen: boolean;
	flagged: boolean;
	answered: boolean;
	draft: boolean;
	snippet: string;
	hasAttachments: boolean;
	threadKey: string | null;
	threadCount?: number;
	threadUnread?: number;
	snoozedUntil: number | null;
	messageId: string | null;
	listId: string | null;
}

export function rowToListItem(r: MessageRow): MessageListItem {
	return {
		id: r.id,
		accountId: r.account_id,
		folderId: r.folder_id,
		uid: r.uid,
		subject: r.subject,
		from: JSON.parse(r.from_json),
		to: JSON.parse(r.to_json),
		date: r.internal_date ?? r.date ?? 0,
		seen: !!r.seen,
		flagged: !!r.flagged,
		answered: !!r.answered,
		draft: !!r.draft,
		snippet: r.snippet,
		hasAttachments: !!r.has_attachments,
		threadKey: r.thread_key,
		snoozedUntil: r.snoozed_until,
		messageId: r.message_id,
		listId: r.list_id
	};
}
