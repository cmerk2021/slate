/** Provider presets + Mozilla-style autoconfig / well-known DAV discovery. */

export interface MailPreset {
	id: string;
	name: string;
	imapHost: string;
	imapPort: number;
	imapSecurity: 'tls' | 'starttls';
	smtpHost: string;
	smtpPort: number;
	smtpSecurity: 'tls' | 'starttls';
	caldavUrl?: string;
	carddavUrl?: string;
	note?: string;
}

export const PRESETS: MailPreset[] = [
	{
		id: 'fastmail',
		name: 'Fastmail',
		imapHost: 'imap.fastmail.com', imapPort: 993, imapSecurity: 'tls',
		smtpHost: 'smtp.fastmail.com', smtpPort: 465, smtpSecurity: 'tls',
		caldavUrl: 'https://caldav.fastmail.com/dav/',
		carddavUrl: 'https://carddav.fastmail.com/dav/',
		note: 'Use an app password (Settings → Privacy & Security → App passwords).'
	},
	{
		id: 'gmail',
		name: 'Gmail',
		imapHost: 'imap.gmail.com', imapPort: 993, imapSecurity: 'tls',
		smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecurity: 'tls',
		note: 'Requires an app password with 2-step verification enabled.'
	},
	{
		id: 'outlook',
		name: 'Outlook.com',
		imapHost: 'outlook.office365.com', imapPort: 993, imapSecurity: 'tls',
		smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, smtpSecurity: 'starttls'
	},
	{
		id: 'icloud',
		name: 'iCloud Mail',
		imapHost: 'imap.mail.me.com', imapPort: 993, imapSecurity: 'tls',
		smtpHost: 'smtp.mail.me.com', smtpPort: 587, smtpSecurity: 'starttls',
		note: 'Requires an app-specific password.'
	}
];

export function presetForEmail(email: string): MailPreset | null {
	const domain = email.split('@')[1]?.toLowerCase();
	if (!domain) return null;
	if (['fastmail.com', 'fastmail.fm', 'sent.com', 'mailbox.org' /* not really */].slice(0, 3).includes(domain)) return PRESETS[0];
	if (['gmail.com', 'googlemail.com'].includes(domain)) return PRESETS[1];
	if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return PRESETS[2];
	if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return PRESETS[3];
	return null;
}

/** Attempt Mozilla autoconfig XML for arbitrary domains. */
export async function autodiscover(email: string): Promise<Partial<MailPreset> | null> {
	const preset = presetForEmail(email);
	if (preset) return preset;
	const domain = email.split('@')[1]?.toLowerCase();
	if (!domain) return null;
	const urls = [
		`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
		`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`
	];
	for (const url of urls) {
		try {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), 6000);
			const res = await fetch(url, { signal: ctrl.signal });
			clearTimeout(t);
			if (!res.ok) continue;
			const xml = await res.text();
			const parsed = parseAutoconfig(xml);
			if (parsed) return parsed;
		} catch {
			continue;
		}
	}
	return null;
}

export function parseAutoconfig(xml: string): Partial<MailPreset> | null {
	const imap = xml.match(/<incomingServer[^>]*type="imap"[\s\S]*?<\/incomingServer>/i)?.[0];
	const smtp = xml.match(/<outgoingServer[^>]*type="smtp"[\s\S]*?<\/outgoingServer>/i)?.[0];
	if (!imap || !smtp) return null;
	const tag = (block: string, name: string) => block.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'))?.[1];
	const sec = (s: string | undefined): 'tls' | 'starttls' => (s?.toUpperCase() === 'STARTTLS' ? 'starttls' : 'tls');
	const imapHost = tag(imap, 'hostname');
	const smtpHost = tag(smtp, 'hostname');
	if (!imapHost || !smtpHost) return null;
	return {
		imapHost,
		imapPort: parseInt(tag(imap, 'port') ?? '993', 10),
		imapSecurity: sec(tag(imap, 'socketType')),
		smtpHost,
		smtpPort: parseInt(tag(smtp, 'port') ?? '465', 10),
		smtpSecurity: sec(tag(smtp, 'socketType'))
	};
}
