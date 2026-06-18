# @dollardeploy/brevo-cli

> A zero-dependency [Brevo](https://developers.brevo.com) API client and a `brevo-cli` for managing contacts and transactional email templates.

This package contains two things:

1. **`api.js`** — a small Brevo API v3 client built on the native Node.js `fetch`. No `axios`, no SDK — nothing to install.
2. **`cli.js`** (`brevo-cli`) — a command line tool for managing Brevo **contacts** (list, add, remove, subscribe, unsubscribe) and **transactional templates** (list, show, add, edit).

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

## CLI Usage

```bash
brevo-cli <group> <command> [arguments] [options]
```

### Contacts

| Command                        | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| `contacts list`                | List contacts (auto-paginates, see below)      |
| `contacts add <email>`         | Create a contact                               |
| `contacts remove <email>`      | Delete a contact permanently                   |
| `contacts subscribe <email>`   | Re-subscribe — sets `emailBlacklisted = false` |
| `contacts unsubscribe <email>` | Unsubscribe — sets `emailBlacklisted = true`   |

`subscribe`/`unsubscribe` toggle the contact's **email subscription status**
(`emailBlacklisted`), i.e. whether they receive marketing emails.

Contact options: `--attrs "FIRSTNAME=Jane,LASTNAME=Doe"`, `--list <id1,id2>`,
`--no-subscribe`, `--update` (update if the contact already exists) for `add`;
`--limit`, `--offset` for `list`.

```bash
brevo-cli contacts list --limit all
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

### Auto-pagination (`list`)

Both `contacts list` and `templates list` accept `--limit <n|all>` and `--offset`.
Brevo returns up to 1000 records per request; when `--limit` is larger (or `all`),
the CLI transparently fetches successive pages and trims to the requested count.

### Output

Every command accepts `--json` to print the raw API response instead of a table —
handy for piping into `jq` or feeding other tools.

## Programmatic Usage

```js
const BrevoAPI = require("./api");

const api = BrevoAPI({ apiKey: process.env.BREVO_API_KEY });

const { contacts, count } = await api.contacts.list({ limit: 10 });
console.log(count, contacts);

await api.contacts.update("jane@example.com", { emailBlacklisted: true });
```

Exposed resources: `account.get()`, `contacts.{list,get,create,update,remove}`,
`templates.{list,get,create,update}`, plus a low-level `request(method, path, { query, body })`
for any other Brevo endpoint.

## How it works

- **Auth** — every request sends the `api-key` header, as Brevo requires.
- **Transport** — the native `fetch`; JSON in, JSON out.
- **Errors** — non-2xx responses throw an `Error` carrying Brevo's `message`,
  plus `status` and `code` for programmatic handling.
