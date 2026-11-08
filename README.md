# Slate

A self-hosted, single-user **webmail + calendar + contacts + tasks** app in one Docker container. Slate connects to any standard provider over **IMAP/SMTP** (POP3 fallback) and **CalDAV/CardDAV**, wraps it all in a calm, keyboard-first UI, and keeps your data on your own server.

- **Mail** — live IMAP (IDLE + SSE), threads, split inbox, unified inbox, snooze, full-text search (local FTS5 + server IMAP SEARCH), undo send, rich composer with markdown shortcuts, tracking protection, one-click unsubscribe, sandboxed HTML rendering with a privacy image proxy.
- **Calendar** — month/week/day/agenda, drag to create/move/resize, full recurrence (RRULE/EXDATE/overrides), reminders, iMIP invites (accept/tentative/decline + sending invitations).
- **Contacts** — CardDAV address books, vCard 3/4, merge duplicates, composer autocomplete.
- **Tasks** — CalDAV VTODO with subtasks, priorities, natural-language quick add ("pay rent friday !high").
- **Profiles** — fully isolated workspaces (Personal / Work / …), each with its own accounts, settings, theme, and accent; instant switching with unread badges.
- **Security** — argon2id app password, WebAuthn passkeys, server-side sessions, rate limiting, AES-256-GCM credential encryption at rest, strict CSP, SSRF-protected proxy.

## Quick start

```bash
git clone https://github.com/cmerk2021/slate.git
cd slate
docker compose up -d --build
```

Open http://localhost:3000, create your app password (min 12 chars), name your first profile, then add your mail/CalDAV/CardDAV accounts under **Settings → Accounts**.

> For anything other than localhost, run Slate behind an HTTPS reverse proxy and set `APP_ORIGIN`/`RP_ID` (see below) — passkeys and secure cookies require it.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `APP_ORIGIN` | `http://localhost:3000` | Public origin the app is reached at (scheme + host). Required for passkeys in production. |
| `ORIGIN` | — | Must equal `APP_ORIGIN`; used by the Node server's form-POST origin check. `docker-compose.yml` sets it automatically. |
| `RP_ID` | hostname of `APP_ORIGIN` | WebAuthn relying-party ID (bare hostname, e.g. `mail.example.com`) |
| `APP_SECRET` | auto-generated | Any long random string; derives the AES-256-GCM key encrypting stored account passwords. If unset, a key file is created at `/data/secret.key` (chmod 600). |
| `DATA_DIR` | `/data` | SQLite DB, secret key, and body cache live here — back up this directory |
| `SESSION_DAYS` | `30` | Sliding session expiry |
| `CACHE_MAX_MB` | `2048` | On-disk LRU cap for message bodies/attachments |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `TRUST_PROXY` | `0` | Set `1` behind a reverse proxy so rate limiting sees real client IPs (`X-Forwarded-For`) |
| `MAX_ATTACHMENT_MB` | `25` | Composer attachment size limit |

## Reverse proxy & HTTPS

Slate expects TLS to be terminated by your proxy. **SSE must not be buffered.**

**Caddy** (nothing special needed — SSE works out of the box):

```caddy
mail.example.com {
    reverse_proxy slate:3000
}
```

**nginx:**

```nginx
server {
    server_name mail.example.com;
    listen 443 ssl http2;
    # ... ssl_certificate ...
    location / {
        proxy_pass http://slate:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE: disable buffering and allow long-lived connections
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        client_max_body_size 50m;  # attachments
    }
}
```

**Traefik** (labels on the slate service):

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.slate.rule=Host(`mail.example.com`)
  - traefik.http.routers.slate.tls.certresolver=le
  - traefik.http.services.slate.loadbalancer.server.port=3000
```

Then set in your `.env`: `APP_ORIGIN=https://mail.example.com`, `RP_ID=mail.example.com`, `TRUST_PROXY=1`.

### WebAuthn (passkeys) requirements

Passkeys only work on a **secure origin**: `https://…`, or `http://localhost` for development. `APP_ORIGIN` must exactly match the URL in the browser, and `RP_ID` must be its bare hostname. The Security settings page shows a warning when the origin doesn't qualify.

## Fastmail walkthrough

1. In Fastmail: **Settings → Privacy & Security → Integrations → App passwords → New app password**. Choose scope *Mail, Contacts & Calendars* (or create separate passwords per protocol).
2. In Slate: **Settings → Accounts → Mail (IMAP+SMTP)**, pick the **Fastmail** preset:
   - IMAP `imap.fastmail.com:993` (TLS), SMTP `smtp.fastmail.com:465` (TLS)
   - Username: your full Fastmail address. Password: the app password.
3. **Test connection**, then **Connect account**. Folders and recent mail sync immediately; new mail arrives live via IDLE.
4. Add **Calendar/Tasks (CalDAV)** with URL `https://caldav.fastmail.com/dav/` and **Contacts (CardDAV)** with `https://carddav.fastmail.com/dav/`, same username + app password.

Mixing providers works fine — e.g. Fastmail for mail plus a self-hosted Radicale/Baikal/Nextcloud for calendar, contacts, and tasks in the same profile.

## Development

```bash
npm install
npm run dev                             # http://localhost:3000 (DATA_DIR defaults to ./data)
docker compose -f docker-compose.dev.yml up -d   # mock servers, no real accounts needed
```

Mock endpoints (dev compose):

| Service | Endpoint | Credentials |
|---|---|---|
| GreenMail IMAP | `localhost:3143`, security **None** | any user/password (e.g. `demo@slate.test` / `demo`) |
| GreenMail SMTP | `localhost:3025`, security **None** | same |
| GreenMail POP3 | `localhost:3110`, security **None** | same |
| Radicale CalDAV/CardDAV | `http://localhost:5232/` | `demo` / `demo` |

Tests:

```bash
npm test          # vitest unit tests (crypto, reply computation, RRULE/iMIP, sanitizer, search & quick-add parsers, vCard)
npm run test:e2e  # Playwright smoke: first-run setup, login, profile creation (builds the app first)
npm run check     # svelte-check / strict TypeScript
```

## Backup & upgrade

- **Backup:** the `/data` volume is everything — SQLite database (WAL), `secret.key`, and the body cache. Stop the container (or accept a crash-consistent copy; SQLite WAL tolerates it) and copy the directory.
- **Upgrade:** `docker compose pull && docker compose up -d` (or rebuild). Database migrations run automatically on startup. Downgrades are not supported; take a backup before upgrading.
- If you set `APP_SECRET`, keep it safe — losing it means stored account passwords can't be decrypted and must be re-entered. The same applies to an auto-generated `/data/secret.key`.

## Security notes

- Single user by design. No account enumeration surface; login is rate-limited per IP and globally with exponential backoff.
- Account credentials are encrypted at rest (AES-256-GCM, key from `APP_SECRET` via scrypt or from `secret.key`). Credentials never reach the browser and are never logged.
- HTML mail is sanitized with a strict allowlist and rendered in a sandboxed iframe without scripts. Remote images are blocked by default and, when allowed, fetched through an authenticated SSRF-guarded proxy (private/loopback/link-local ranges refused, content-type and size checked) so senders never see your IP.
- Tracking pixels are stripped and tracking query parameters removed from links; the message header shows a "trackers blocked" count.
- CSP is strict; the only inline script is the pre-paint theme snippet. Sessions are HttpOnly, SameSite=Lax, Secure on HTTPS.

## Keyboard shortcuts

Press `?` in the app for the full cheat sheet. Highlights:

| Key | Action |
|---|---|
| `Cmd/Ctrl K` | Command palette |
| `Cmd/Ctrl .` | Today side panel |
| `Cmd/Ctrl 1–9` | Switch profile |
| `j` / `k` | Next / previous message |
| `o` / `Enter`, `u` | Open, back to list |
| `e` / `#` / `!` | Archive / delete / spam |
| `r` / `a` / `f` / `c` | Reply / reply-all / forward / compose |
| `s`, `b`, `z` | Star, snooze, undo |
| `x`, `Shift+I/U` | Select, mark read/unread |
| `/`, `g` then `i/s/d/t/c` | Search, go to inbox/sent/drafts/today/calendar |
| `t` | Create task from email |

## Design decisions

- **SQLite everything.** Headers, flags, threads, calendar and contact caches, sessions, outbox, and FTS5 index live in one WAL-mode database; message bodies/attachments go to a size-bounded disk LRU. One volume to back up.
- **Live IMAP, smart cache.** The server of record is the mail server. Slate holds a persistent connection pool with IDLE per inbox and uses CONDSTORE/QRESYNC when available, falling back to UID diffing. Bodies fetch on demand.
- **Undo send is server-side.** Sends sit in a persisted outbox queue until the delay elapses, so closing the tab neither loses nor double-sends mail; the queue resumes after a restart.
- **Snooze is local.** IMAP has no snooze, so snoozed messages hide in a virtual view and a scheduler restores them (also after restarts). The messages never leave their folder on the server.
- **Profiles are hard walls.** Separate accounts, caches, settings, and rules per profile; no unified cross-profile views, by design.
- **One inline script.** Theme is applied before first paint from a cookie to avoid flashes; everything else, including fonts (Bricolage Grotesque + Instrument Sans, self-hosted WOFF2), ships from the container with zero external requests.
- **vCard writes use 3.0** for maximum server compatibility; both 3.0 and 4.0 parse.
- **POP3 is explicitly reduced**: local-only folders, fetch-and-store (optionally leaving mail on the server), SMTP for sending; the UI labels the limitations.

## Non-goals

No multi-user, no built-in TLS (bring a reverse proxy), no AI features, no tracking/read receipts, no native apps (it's an installable PWA).

## License

See [LICENSE](LICENSE).
