# Let Ready

Track compliance certificates, tenancies and deposit deadlines for each London rental property in one place.

## What it does

- **Property checklist:** gas safety certificate (CP12), electrical report (EICR), energy performance certificate (EPC), HMO licence, Renters' Rights Act information sheet and PRS Database registration. Each item shows its status, expiry date and days left.
- **Tenancies and deposits:** record each tenant, the deposit amount and dates. The app works out the 30-day deadlines for deposit protection and prescribed information, and flags a deposit that was protected late.
- **Certificate uploads:** attach PDF, JPEG or PNG certificates to each checklist item (up to 5 MB each, up to 10 per item). Files are checked against their type, so a renamed file is refused.
- **Dashboard:** portfolio readiness and everything that needs action, most urgent first.
- **Reports and exports:** a CSV checklist for each property (safe to open in a spreadsheet), and a JSON export of the whole account.
- **Email reminders:** 30 and 7 days before a deadline, and once when it has passed. Each deadline sends at most one reminder per stage. Reminders can be switched off in Settings. Email sending needs a provider (see below).
- **Accounts:** email and password login, password reset by email, rate limiting on logins and reset requests, sessions that expire after 30 days, and account deletion.

> Let Ready is a tracker, not legal advice. The rules in `docs/SOURCES.md` were checked against several sources, but some could not be confirmed on gov.uk. Check current guidance before relying on it.

## Requirements

- Node.js 22.13 or later. The app uses Node's built-in SQLite module, so there are no packages to install.

## Run it

```bash
npm start
```

Then open http://localhost:3000, create an account and add a property.

### Settings (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `data` | Folder for the database file |
| `APP_URL` | `http://localhost:PORT` | Public address, used in email links. Use `https://` in production. |
| `SECURE_COOKIES` | unset | Set to `1` to mark the session cookie `Secure`. Automatic when `APP_URL` is https. |
| `TRUST_PROXY` | unset | Set to `1` only when behind a reverse proxy that sets `X-Forwarded-For`. Otherwise every user shares the proxy's address for rate limiting. |
| `MAIL_PROVIDER` | `none` | `none` sends no email. `resend` sends through the [Resend API](https://resend.com/docs/api-reference/emails/send-email). |
| `MAIL_FROM` | unset | Sender address, for example `Let Ready <hello@your-domain.example>`. Required with `resend`. |
| `RESEND_API_KEY` | unset | Resend API key. Required with `resend`. Keep it secret. |
| `REMINDER_INTERVAL_MINUTES` | `60` | How often reminders are queued and sent |

With `MAIL_PROVIDER=none` (the default), no email is sent and no reminders are queued. Password reset requests are still written to the outbox, but nothing sends them until a provider is set.

## Backups

```bash
npm run backup -- data/letready.db backups/letready-2026-10-30.db
```

The backup uses SQLite's `VACUUM INTO`, so it is consistent even while the app is running. It checks the copy before reporting success, and it never overwrites an existing file. Store backups somewhere other than the server.

## Test it

```bash
npm test
```

The suite has 96 tests in eight files:

- `compliance.test.js`: validity periods, due-soon windows, the 30-day deposit rules, scoring, and reminder buckets.
- `api.test.js`: accounts, sessions, password reset, rate limits, properties, items, tenancies, uploads, exports, security headers, and input errors.
- `reminders.test.js`: reminder queueing (idempotent), the email outbox with retries and backoff, and the Resend request format.
- `migrations.test.js`: new databases, upgrades from version 1 with data kept, refusal of newer schemas, and rollback of a failed migration.
- `backup.test.js`: consistent backups, no overwriting, and quoting in paths.
- `security.test.js`: CSV formula protection, filename and file-signature checks, the rate limiter, password hashing, cookie flags, and WCAG AA contrast for both themes.
- `fuzz.test.js`: 400 seeded random requests across all endpoints. No input may cause a server error.
- `e2e.test.js`: the main journey in a real browser (skipped if Playwright or Chromium is missing).

The suite runs one test file at a time. It passed on five consecutive runs.

## How it is built

- `src/compliance.js`: the rules and status calculations. No database or HTTP code, so it is easy to test.
- `src/routes.js`: the API route table. `src/server.js` handles HTTP, static files, body limits, rate-limit IP detection and security headers.
- `src/handlers/`: request handlers for accounts, properties, tenancies and documents.
- `src/validate.js`: all input checks. Every user-entered value passes through one of these.
- `src/details.js` and `src/store.js`: the shared read path, so the dashboard and property pages can't disagree.
- `src/mailer.js`, `src/reminders.js`, `src/jobs.js`: the email outbox, reminder queue and background job.
- `src/db.js`: versioned schema migrations, recorded in `PRAGMA user_version`.
- `public/`: a single-page app with no dependencies. It builds the page with DOM nodes rather than HTML strings, so user-entered text is never run as markup.

## Security

- Passwords are hashed with scrypt and a per-user salt. Session tokens and password-reset tokens are stored only as SHA-256 hashes.
- Login attempts are limited to 10 per email per 15 minutes, and 100 per IP. Password-reset requests are limited to 3 per email per hour.
- The forgot-password reply is the same whether or not the account exists.
- Every route that reads or writes a property checks that it belongs to the signed-in user. Other users' ids return "not found".
- Uploads are checked by file signature and size. Downloads are sent as attachments with `nosniff`.
- CSV exports protect against spreadsheet formula injection.
- Responses carry a Content-Security-Policy, `X-Content-Type-Options`, `frame-ancestors 'none'` and `no-store` for API data.
- Writes must be JSON, which blocks cross-site form posts.

## Known limitations

- **Email needs a provider.** Reminders and password reset emails are sent only when `MAIL_PROVIDER=resend` is set and a sender domain is verified. The Resend integration was checked against its API reference and unit-tested with a fake server, but it has not been sent live.
- **Rate limits are in memory.** They reset when the app restarts and are not shared between instances. For more than one instance, move them to a shared store.
- **One database file.** SQLite suits a single server. Move to a hosted database before running several app servers.
- **Personal data.** Tenant names and deposit details are personal data under UK GDPR. Decide your retention and privacy notice before using the app with real tenants.
- **Reminder email subjects include tenant names**, so they can be seen in an inbox preview.
- **Deadlines use the default validity periods** unless the expiry date is entered from the certificate. Enter the dates printed on the documents.
- **PRS Database deadlines are not calculated.** The regional dates conflict across sources. See `docs/SOURCES.md`.
- **No login two-factor authentication.**
- **Request timeouts** are 30 seconds, which is enough for uploads on ordinary connections but may be short on a slow mobile connection.
