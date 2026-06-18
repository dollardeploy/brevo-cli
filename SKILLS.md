---
name: brevo-cli
description: Use when managing Brevo (Sendinblue) from the terminal — listing/adding/removing contacts, subscribing or unsubscribing them from marketing email, or listing/showing/adding/editing transactional email templates (welcome/automated emails). Triggers on "brevo contacts", "brevo templates", "unsubscribe contact", "transactional template", "edit welcome email", "brevo api cli".
---

# Brevo CLI (brevo-cli)

Manage [Brevo](https://developers.brevo.com) contacts and transactional email
templates from the command line. Zero dependencies — uses native Node `fetch`
against the Brevo API v3.

## Setup

```bash
export BREVO_API_KEY="xkeysib-..."   # Settings → SMTP & API → API Keys
```

Run from `tools/brevo-cli/`:

```bash
node cli.js <group> <command> [options]
# or, if installed globally / linked:
brevo-cli <group> <command> [options]
```

## Contacts

| Task           | Command                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| List contacts  | `brevo-cli contacts list [--limit 20] [--offset 40] [--json]`               |
| List everyone  | `brevo-cli contacts list --limit all` (auto-paginates)                      |
| Add contact    | `brevo-cli contacts add jane@example.com --attrs "FIRSTNAME=Jane" --list 3` |
| Add (upsert)   | `brevo-cli contacts add jane@example.com --update`                          |
| Remove contact | `brevo-cli contacts remove jane@example.com`                                |
| Unsubscribe    | `brevo-cli contacts unsubscribe jane@example.com`                           |
| Re-subscribe   | `brevo-cli contacts subscribe jane@example.com`                             |

`subscribe`/`unsubscribe` toggle the contact's **`emailBlacklisted`** flag
(marketing email opt-in/out). They do **not** add or remove the contact from
lists — use `--list` on `add` for list membership.

## Templates (transactional / automated emails)

The transactional email templates behind automated emails (welcome, subscription
confirmations, etc.).

| Task                  | Command                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| List templates        | `brevo-cli templates list [--active\|--inactive]`                                                                         |
| Show a template       | `brevo-cli templates show 3`                                                                                              |
| Print/save its HTML   | `brevo-cli templates show 3 --html` (stdout) or `--html welcome.html` (file)                                              |
| Create a template     | `brevo-cli templates add --name "Welcome" --subject "Hi" --html ./w.html --sender-email hello@x.com --sender-name "Team"` |
| Edit subject/body     | `brevo-cli templates edit 3 --subject "Welcome aboard" --html ./w.html`                                                   |
| Activate / deactivate | `brevo-cli templates edit 3 --active` / `--inactive`                                                                      |

Template fields: `--name`, `--subject`, `--html` (file path or inline),
`--sender-email` + `--sender-name` (or `--sender-id`), `--active`/`--inactive`.

## Key Behaviors

- **`--html`** accepts a **file path or inline text** (like ghost-cli's markdown).
- **Auto-pagination:** `contacts list`/`templates list` page automatically when
  `--limit` exceeds 1000 (Brevo's per-request max) or is `all`. `--offset` sets
  the start.
- **`--json`** on any command prints the raw API response (good for `jq`/agents).
- Credential resolution: `--key` flag > `BREVO_API_KEY` env;
  `--url` flag > `BREVO_API_URL` env > `https://api.brevo.com/v3`.
- Errors surface Brevo's `message` (e.g. `Contact does not exist`).

## Safety Notes

- `contacts remove`, `unsubscribe`, and template edits mutate live data — confirm
  the email/template id and that you are pointed at the right Brevo account.
- Toggling `emailBlacklisted` changes a contact's marketing-consent state; treat
  it as a real subscription change, not a no-op.

## Library Use

`api.js` can be required directly:
`contacts.{list,get,create,update,remove}`, `templates.{list,get,create,update}`,
`account.get()`, and a low-level `request(method, path, {query, body})` for any
other Brevo endpoint. See `README.md`.
