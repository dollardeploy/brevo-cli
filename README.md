# @dollardeploy/brevo-cli

> A zero-dependency [Brevo](https://developers.brevo.com) API client and a `brevo-cli` for managing contacts and transactional email templates.

This package contains two things:

1. **`api.js`** — a small Brevo API v3 client built on the native Node.js `fetch`. No `axios`, no SDK — nothing to install.
2. **`cli.js`** (`brevo-cli`) — a command line tool for managing Brevo **contacts** (list, show, add, remove, subscribe, unsubscribe) and **transactional templates** (list, show, add, edit), plus read-only **reporting** (lists, e-mail stats, campaigns).

## Requirements

- Node.js >= 22 (for the global `fetch` API).

## Configuration

| Setting  | Flag    | Environment variable | Default                    |
| -------- | ------- | -------------------- | -------------------------- |
| API key  | `--key` | `BREVO_API_KEY`      | — (required)               |
| Base URL | `--url` | `BREVO_API_URL`      | `https://api.brevo.com/v3` |

Create an API key in Brevo under **Settings → SMTP & API → API Keys** (it starts
with `xkeysib-`).

```bash
export BREVO_API_KEY="xkeysib-..."
```

Alternatively, drop this in a `.env.production` file in the directory you run
from — the CLI loads it automatically on startup. Variables already set in the
environment always take precedence over the file.

## CLI Usage

```bash
brevo-cli <group> <command> [arguments] [options]
```

### Contacts

| Command                        | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| `contacts list`                | List contacts (auto-paginates, see below)      |
| `contacts show <email>`        | Show one contact (read only, see below)        |
| `contacts add <email>`         | Create a contact                               |
| `contacts remove <email>`      | Delete a contact permanently                   |
| `contacts subscribe <email>`   | Re-subscribe — sets `emailBlacklisted = false` |
| `contacts unsubscribe <email>` | Unsubscribe — sets `emailBlacklisted = true`   |

`subscribe`/`unsubscribe` toggle the contact's **email subscription status**
(`emailBlacklisted`), i.e. whether they receive marketing emails.

Contact options: `--attrs "FIRSTNAME=Jane,LASTNAME=Doe"`, `--list <id1,id2>`,
`--no-subscribe`, `--update` (update if the contact already exists) for `add`;
`--limit`, `--offset`, `--since <date|Nd>`, `--modified-since <date|Nd>` and
`--count` for `list`.

`--since` / `--modified-since` accept `YYYY-MM-DD` (start of that day, UTC), a
full ISO timestamp, or `Nd` for N days ago (`7d`). With a date filter `list`
returns all matches unless `--limit` is set. `--count` prints only the number of
matching contacts (one API request).

The `contacts list` table has no e-mail column (id, status, lists, created), so
it is safe to paste into reports; use `--json` or `contacts show` for addresses.
`contacts show` prints attributes, list ids with names, blacklist state,
created/modified and the contact's message statistics (sent, delivered, opened,
clicked, bounces, unsubscriptions). Brevo only reports campaign messages in these
statistics, not transactional ones; use `stats --template` for those.

```bash
brevo-cli contacts list --limit all
brevo-cli contacts list --since 7d --count       # created in the last 7 days
brevo-cli contacts list --since 2026-10-23       # table without e-mails
brevo-cli contacts show jane@example.com
brevo-cli contacts add jane@example.com --attrs "FIRSTNAME=Jane" --list 3
brevo-cli contacts unsubscribe jane@example.com
brevo-cli contacts subscribe jane@example.com
brevo-cli contacts remove jane@example.com
```

### Templates (transactional / automated emails)

These are the transactional email templates that power automated emails such as
welcome and subscription messages.

| Command                      | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `templates list`             | List templates (`--active` / `--inactive` to filter) |
| `templates show <id>`        | Show a template's details, or its HTML with `--html` |
| `templates add --name "..."` | Create a template                                    |
| `templates edit <id>`        | Update a template                                    |

Template options:

| Option                    | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `--name <name>`           | Template name                                        |
| `--subject <subject>`     | Email subject line                                   |
| `--html <file\|text>`     | (add/edit) HTML body from a file path or inline text |
| `--html [file]`           | (show) Print the HTML body, or write it to `<file>`  |
| `--sender-email <email>`  | Sender email address                                 |
| `--sender-name <name>`    | Sender display name                                  |
| `--sender-id <id>`        | Use an existing sender by ID (instead of email/name) |
| `--active` / `--inactive` | Activate or deactivate the template                  |

```bash
brevo-cli templates list --active
brevo-cli templates show 3
brevo-cli templates show 3 --html              # print the HTML body
brevo-cli templates show 3 --html welcome.html # save the HTML body to a file
brevo-cli templates add --name "Welcome" --subject "Hi {{contact.FIRSTNAME}}" \
  --html ./welcome.html --sender-email hello@example.com --sender-name "Team"
brevo-cli templates edit 3 --subject "Welcome aboard" --html ./welcome.html --active
```

### Reporting (read only)

These commands only read from Brevo. Their table output never contains e-mail
addresses.

| Command                 | Brevo API                                    | Output                                                                                                         |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lists`                 | `GET /contacts/lists`                        | id, name, subscribers, blacklisted                                                                             |
| `stats [--days 30]`     | `GET /smtp/statistics/aggregatedReport`      | requests, delivered, opens, unique opens, clicks, unique clicks, hard/soft bounces, spam reports, unsubscribed |
| `stats --daily`         | `GET /smtp/statistics/reports`               | one row per day (default 14 days) with the same metrics; days without e-mails show as 0                        |
| `stats --template <id>` | `GET /smtp/statistics/events`                | events and unique recipients per event type for one transactional template (default 30 days)                   |
| `campaigns list`        | `GET /emailCampaigns?statistics=globalStats` | id, name, subject, status, sent date, delivered, unique opens, unique clicks                                   |

Options: `--days <n>`; `--event <e1,e2>` for `stats --template` (default
`requests,delivered,opened,clicks`; also `hardBounces`, `softBounces`, `bounces`,
`spam`, `unsubscribed`, `blocked`, `invalid`, `deferred`, `error`); `--status <status>`
(`draft`, `sent`, `archive`, `queued`, `suspended`, `in_process`) and `--limit`/`--offset`
for `campaigns list`.

`stats --template` pages through every event (2500 per request) and only uses the
recipient addresses to count unique recipients; `--json` prints the same counts,
not raw events.

```bash
brevo-cli lists
brevo-cli stats --days 30
brevo-cli stats --daily --days 14
brevo-cli stats --template 1 --days 30
brevo-cli stats --template 1 --event delivered,opened,clicks --json
brevo-cli campaigns list --status sent
```

**Automation workflows:** Brevo has no public API for automation workflows
(`/automation/workflows` returns 404, checked 2026-11-14), so the CLI has no
command for them. Check automation e-mails through the transactional template
they send with `stats --template <id>`.

### Auto-pagination (`list`)

`contacts list`, `templates list`, `campaigns list` and `lists` accept `--limit <n|all>` and `--offset`.
Brevo returns up to 1000 records per request; when `--limit` is larger (or `all`),
the CLI transparently fetches successive pages and trims to the requested count.

### Output

Every command accepts `--json` to print the API response (or the computed counts for
`stats --daily`, `stats --template` and `contacts list --count`) instead of a table —
handy for piping into `jq` or feeding other tools.

## Programmatic Usage

```js
const BrevoAPI = require("./api");

const api = BrevoAPI({ apiKey: process.env.BREVO_API_KEY });

const { contacts, count } = await api.contacts.list({ limit: 10 });
console.log(count, contacts);

await api.contacts.update("jane@example.com", { emailBlacklisted: true });
```

Exposed resources: `account.get()`, `contacts.{list,get,create,update,remove,lists}`,
`templates.{list,get,create,update}`, `stats.{aggregated,daily,events}`,
`campaigns.list()`, plus a low-level `request(method, path, { query, body })`
for any other Brevo endpoint.

## How it works

- **Auth** — every request sends the `api-key` header, as Brevo requires.
- **Transport** — the native `fetch`; JSON in, JSON out.
- **Errors** — non-2xx responses throw an `Error` carrying Brevo's `message`,
  plus `status` and `code` for programmatic handling.
