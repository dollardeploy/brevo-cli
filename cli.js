#!/usr/bin/env node

const fs = require("fs");

// Nearest .env.production at or above the current directory, else at or above this script.
// The file lives only in the main checkout, so this also works from a Gene workspace under .gene/
{
  const fs = require("node:fs");
  const path = require("node:path");
  const findUp = dir => {
    const file = path.join(dir, ".env.production");
    if (fs.existsSync(file)) {
      return file;
    }
    const parent = path.dirname(dir);
    return parent === dir ? undefined : findUp(parent);
  };
  const envFile = findUp(process.cwd()) ?? findUp(__dirname);
  if (envFile) {
    process.loadEnvFile(envFile);
  }
}

const BrevoAPI = require("./api");

const logger = console;

// Brevo allows up to 1000 records per list request.
const MAX_PAGE_SIZE = 1000;

// Brevo allows up to 50 records per /contacts/lists request.
const MAX_LISTS_PAGE_SIZE = 50;

// Brevo allows up to 100 records per /emailCampaigns request.
const MAX_CAMPAIGNS_PAGE_SIZE = 100;

// Page size used to walk /smtp/statistics/events (Brevo maximum is 5000).
const EVENTS_PAGE_SIZE = 2500;

const DEFAULT_TEMPLATE_EVENTS = "requests,delivered,opened,clicks";

const DAY_MS = 24 * 60 * 60 * 1000;

// Flags that never take a value.
const BOOLEAN_FLAGS = new Set(["json", "active", "inactive", "update", "count", "daily"]);

const USAGE = `brevo-cli - manage Brevo contacts and transactional templates, check e-mail stats

Usage:
  brevo-cli <group> <command> [arguments] [options]
  brevo-cli lists | stats [options]

Contact commands:
  contacts list                    List contacts (auto-paginates over 1000 / "all"), no e-mails in the table
  contacts show <email>            Show one contact: attributes, lists, blacklist state, message statistics
  contacts add <email>             Create a contact
  contacts remove <email>          Delete a contact permanently
  contacts subscribe <email>       Re-subscribe (emailBlacklisted = false)
  contacts unsubscribe <email>     Unsubscribe (emailBlacklisted = true)

Template commands (transactional / automated emails):
  templates list                   List transactional email templates
  templates show <id>              Show a template (--html prints/writes its body)
  templates add --name "..."       Create a template
  templates edit <id>              Update a template

Read-only reporting commands:
  lists                            Contact lists: id, name, subscribers, blacklisted
  stats                            Transactional e-mail totals for the last --days (default 30)
  stats --daily                    One row per day for the last --days (default 14), incl. days with 0 sent
  stats --template <id>            Event counts and unique recipients for one template (default 30 days)
  campaigns list                   E-mail campaigns with delivered, opens and clicks

Automation workflows have no public Brevo API, so there is no command for them.

Connection options:
  --key <api-key>                  Brevo API key (default: BREVO_API_KEY)
  --url <base-url>                 API base URL (default: BREVO_API_URL or https://api.brevo.com/v3)

Contact options:
  --attrs "K=V,K2=V2"              [add] Contact attributes (keys upper-cased, e.g. FIRSTNAME=Jane)
  --list <id1,id2>                 [add] List IDs to add the contact to
  --no-subscribe                   [add] Create the contact already unsubscribed
  --update                         [add] Update the contact if it already exists
  --limit <n|all>                  [list] How many to return (default 50, "all" with --since)
  --offset <n>                     [list] Starting offset (default 0)
  --since <date|Nd>                [list] Created since YYYY-MM-DD, ISO timestamp or N days ago (7d)
  --modified-since <date|Nd>       [list] Modified since YYYY-MM-DD, ISO timestamp or N days ago
  --count                          [list] Print only the number of matching contacts

Stats and campaign options:
  --days <n>                       Days to report (default 30, 14 with --daily)
  --daily                          [stats] One row per day
  --template <id>                  [stats] Report events of one transactional template
  --event <e1,e2>                  [stats --template] Events to count (default ${DEFAULT_TEMPLATE_EVENTS}),
                                   any of requests, delivered, opened, clicks, hardBounces, softBounces,
                                   bounces, spam, unsubscribed, blocked, invalid, deferred, error
  --status <status>                [campaigns list] draft, sent, archive, queued, suspended, in_process
  --limit <n|all> / --offset <n>   [campaigns list, lists] Pagination

Template options:
  --name <name>                    Template name
  --subject <subject>              Email subject line
  --html <file|text>               [add/edit] HTML body from a file path or inline text
  --html [file]                    [show] Print the HTML body, or write it to <file>
  --sender-email <email>           Sender email address
  --sender-name <name>             Sender display name
  --sender-id <id>                 Use an existing sender by ID (instead of email/name)
  --active                         Mark template active
  --inactive                       Mark template inactive
  --limit <n|all> / --offset <n>   [list] Pagination

General:
  --json                           Print raw JSON instead of a table
  -h, --help                       Show this help

Environment:
  BREVO_API_KEY, BREVO_API_URL

Examples:
  brevo-cli contacts list --limit all
  brevo-cli contacts list --since 7d --count        # contacts created in the last 7 days
  brevo-cli contacts list --since 2026-10-23
  brevo-cli contacts show jane@example.com
  brevo-cli lists
  brevo-cli stats --days 30
  brevo-cli stats --daily --days 14
  brevo-cli stats --template 1 --days 30
  brevo-cli campaigns list --status sent
  brevo-cli contacts add jane@example.com --attrs "FIRSTNAME=Jane,LASTNAME=Doe" --list 3
  brevo-cli contacts unsubscribe jane@example.com
  brevo-cli contacts subscribe jane@example.com
  brevo-cli templates list --active
  brevo-cli templates show 3
  brevo-cli templates show 3 --html                 # print the HTML body
  brevo-cli templates show 3 --html welcome.html    # save the HTML body to a file
  brevo-cli templates add --name "Welcome" --subject "Hi {{contact.FIRSTNAME}}" \\
    --html ./welcome.html --sender-email hello@example.com --sender-name "Team"
  brevo-cli templates edit 3 --subject "Welcome aboard" --html ./welcome.html`;

function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--no-subscribe") {
      options.subscribe = false;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        options[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
      continue;
    }

    positionals.push(arg);
  }

  return {
    group: positionals[0],
    command: positionals[1],
    args: positionals.slice(2),
    options
  };
}

function createClient(options) {
  const apiKey = options.key || process.env.BREVO_API_KEY;
  const baseUrl = options.url || process.env.BREVO_API_URL;

  if (!apiKey) {
    throw new Error("Missing API key. Pass --key or set BREVO_API_KEY.");
  }

  return BrevoAPI({ apiKey, baseUrl });
}

function readInput(value) {
  if (value && fs.existsSync(value) && fs.statSync(value).isFile()) {
    return fs.readFileSync(value, "utf8");
  }
  return String(value);
}

// Fetch a list resource across pages using Brevo's limit/offset pagination,
// then trim to the requested limit. `key` is the array property in the response.
async function paginate(
  listFn,
  key,
  baseQuery,
  options,
  defaultLimit,
  maxPageSize = MAX_PAGE_SIZE
) {
  const limit = options.limit || defaultLimit;
  const fetchAll = limit === "all";
  const target = fetchAll ? Infinity : Number(limit);

  const collected = [];
  let offset = options.offset ? Number(options.offset) : 0;
  let total = 0;

  while (collected.length < target) {
    const pageSize = Math.min(maxPageSize, fetchAll ? maxPageSize : target - collected.length);
    const result = await listFn({ ...baseQuery, limit: pageSize, offset });

    if (result && typeof result.count === "number") {
      total = result.count;
    }
    const batch = (result && result[key]) || [];
    collected.push(...batch);
    offset += batch.length;

    if (!batch.length || batch.length < pageSize || offset >= total) {
      break;
    }
  }

  const items = fetchAll ? collected : collected.slice(0, target);
  return { items, total, fetched: items.length };
}

function printTable(columns, items) {
  if (!items.length) {
    logger.info("No results.");
    return;
  }

  const rows = items.map(item =>
    columns.reduce(
      (row, column) => Object.assign(row, { [column.key]: String(column.value(item)) }),
      {}
    )
  );

  const widths = columns.reduce((acc, column) => {
    const valueWidth = rows.reduce((max, row) => Math.max(max, row[column.key].length), 0);
    acc[column.key] = Math.max(column.header.length, valueWidth);
    return acc;
  }, {});

  const formatRow = getValue =>
    columns.map(column => getValue(column).padEnd(widths[column.key])).join("  ");

  logger.info(formatRow(column => column.header.toUpperCase()));
  logger.info(columns.map(column => "-".repeat(widths[column.key])).join("  "));
  rows.forEach(row => logger.info(formatRow(column => row[column.key])));
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function printJson(value) {
  logger.info(JSON.stringify(value, null, 2));
}

// Print aligned "Label:  value" lines.
function printFields(fields) {
  const width = fields.reduce((max, [label]) => Math.max(max, label.length), 0) + 2;
  fields.forEach(([label, value]) => logger.info(`${`${label}:`.padEnd(width)}${value}`));
}

function parsePositiveInt(value, name, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`--${name} must be a positive integer, got "${value}".`);
  }
  return number;
}

// Accepts "7d" (7 days ago), "YYYY-MM-DD" (start of that day, UTC) or a full ISO timestamp,
// returns the ISO timestamp Brevo expects in createdSince / modifiedSince.
function parseSince(value, name) {
  const text = String(value);
  const daysAgo = /^(\d+)d$/.exec(text);
  if (daysAgo) {
    return new Date(Date.now() - Number(daysAgo[1]) * DAY_MS).toISOString();
  }
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text;
  const date = new Date(isoDate);
  if (value === true || !/^\d{4}-\d{2}-\d{2}/.test(text) || Number.isNaN(date.getTime())) {
    throw new Error(
      `--${name} must be YYYY-MM-DD, an ISO timestamp or Nd (e.g. 7d), got "${value}".`
    );
  }
  return date.toISOString();
}

// YYYY-MM-DD of a Date in UTC.
const toDay = date => date.toISOString().slice(0, 10);

async function fetchAllLists(api) {
  const { items } = await paginate(
    query => api.contacts.lists(query),
    "lists",
    {},
    { limit: "all" },
    "all",
    MAX_LISTS_PAGE_SIZE
  );
  return items;
}

// ---- Contacts --------------------------------------------------------------

function parseAttrs(value) {
  const attributes = {};
  String(value)
    .split(",")
    .forEach(pair => {
      const index = pair.indexOf("=");
      if (index === -1) {
        return;
      }
      const key = pair.slice(0, index).trim().toUpperCase();
      const attrValue = pair.slice(index + 1).trim();
      if (key) {
        attributes[key] = attrValue;
      }
    });
  return attributes;
}

async function contactsList(api, options) {
  const filters = {};
  if (options.since !== undefined) {
    filters.createdSince = parseSince(options.since, "since");
  }
  if (options["modified-since"] !== undefined) {
    filters.modifiedSince = parseSince(options["modified-since"], "modified-since");
  }
  const filtered = Object.keys(filters).length > 0;

  if (options.count) {
    const result = await api.contacts.list({ ...filters, limit: 1, offset: 0 });
    const count = (result && result.count) || 0;
    if (options.json) {
      printJson({ count, ...filters });
      return;
    }
    logger.info(String(count));
    return;
  }

  const { items, total, fetched } = await paginate(
    query => api.contacts.list(query),
    "contacts",
    filters,
    options,
    filtered ? "all" : 50
  );

  if (options.json) {
    printJson(items);
    return;
  }

  // No e-mail column: table output never shows addresses, use --json or "contacts show".
  printTable(
    [
      { key: "id", header: "id", value: c => c.id || "" },
      {
        key: "status",
        header: "status",
        value: c => (c.emailBlacklisted ? "unsubscribed" : "subscribed")
      },
      { key: "lists", header: "lists", value: c => (c.listIds ? c.listIds.length : 0) },
      { key: "created", header: "created", value: c => (c.createdAt || "").slice(0, 10) }
    ],
    items
  );
  logger.info(`\nShowing ${fetched} of ${total} contacts.`);
}

// Number of entries in a contact statistics field (an array of events, or nested arrays).
function countEvents(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce((sum, nested) => sum + countEvents(nested), 0);
  }
  return 0;
}

async function contactsShow(api, email, options) {
  const [contact, lists] = await Promise.all([api.contacts.get(email), fetchAllLists(api)]);

  if (options.json) {
    printJson(contact);
    return;
  }

  const listNames = new Map(lists.map(list => [list.id, list.name]));
  const listIds = contact.listIds || [];
  const statistics = contact.statistics || {};
  const attributes = Object.entries(contact.attributes || {});

  printFields([
    ["ID", contact.id],
    ["Email", contact.email || ""],
    ["Email blacklisted", contact.emailBlacklisted ? "yes" : "no"],
    ["SMS blacklisted", contact.smsBlacklisted ? "yes" : "no"],
    ["Created", contact.createdAt || ""],
    ["Modified", contact.modifiedAt || ""],
    [
      "Lists",
      listIds.length
        ? listIds.map(id => `${id} (${listNames.get(id) || "unknown"})`).join(", ")
        : "none"
    ],
    ["Sent", countEvents(statistics.messagesSent)],
    ["Delivered", countEvents(statistics.delivered)],
    ["Opened", countEvents(statistics.opened)],
    ["Clicked", countEvents(statistics.clicked)],
    ["Hard bounces", countEvents(statistics.hardBounces)],
    ["Soft bounces", countEvents(statistics.softBounces)],
    ["Unsubscriptions", countEvents(statistics.unsubscriptions)]
  ]);

  logger.info("\nAttributes:");
  if (!attributes.length) {
    logger.info("  none");
    return;
  }
  printFields(attributes.map(([key, value]) => [`  ${key}`, value]));
}

async function contactsAdd(api, email, options) {
  const data = { email };
  if (options.attrs) {
    data.attributes = parseAttrs(options.attrs);
  }
  if (options.list) {
    data.listIds = String(options.list)
      .split(",")
      .map(id => Number(id.trim()))
      .filter(id => !Number.isNaN(id));
  }
  if (options.subscribe === false) {
    data.emailBlacklisted = true;
  }
  if (options.update) {
    data.updateEnabled = true;
  }

  const result = await api.contacts.create(data);
  if (options.json) {
    logger.info(JSON.stringify(result, null, 2));
    return;
  }
  logger.info(`Added contact ${email}${result && result.id ? ` (id: ${result.id})` : ""}.`);
}

async function contactsRemove(api, email, options) {
  await api.contacts.remove(email);
  if (options.json) {
    logger.info(JSON.stringify({ deleted: email }, null, 2));
    return;
  }
  logger.info(`Removed contact ${email}.`);
}

async function contactsSubscribe(api, email, options) {
  await api.contacts.update(email, { emailBlacklisted: false });
  if (options.json) {
    logger.info(JSON.stringify({ email, emailBlacklisted: false }, null, 2));
    return;
  }
  logger.info(`Subscribed ${email} (emailBlacklisted = false).`);
}

async function contactsUnsubscribe(api, email, options) {
  await api.contacts.update(email, { emailBlacklisted: true });
  if (options.json) {
    logger.info(JSON.stringify({ email, emailBlacklisted: true }, null, 2));
    return;
  }
  logger.info(`Unsubscribed ${email} (emailBlacklisted = true).`);
}

// ---- Templates -------------------------------------------------------------

function resolveSender(options) {
  if (options["sender-id"]) {
    return { id: Number(options["sender-id"]) };
  }
  if (options["sender-email"]) {
    const sender = { email: options["sender-email"] };
    if (options["sender-name"]) {
      sender.name = options["sender-name"];
    }
    return sender;
  }
  return null;
}

async function templatesList(api, options) {
  const baseQuery = { sort: "desc" };
  if (options.active) {
    baseQuery.templateStatus = true;
  } else if (options.inactive) {
    baseQuery.templateStatus = false;
  }

  const { items, total, fetched } = await paginate(
    query => api.templates.list(query),
    "templates",
    baseQuery,
    options,
    50
  );

  if (options.json) {
    logger.info(JSON.stringify(items, null, 2));
    return;
  }

  printTable(
    [
      { key: "id", header: "id", value: t => t.id || "" },
      { key: "name", header: "name", value: t => truncate(t.name, 30) },
      { key: "active", header: "active", value: t => (t.isActive ? "yes" : "no") },
      { key: "subject", header: "subject", value: t => truncate(t.subject, 40) },
      { key: "modified", header: "modified", value: t => (t.modifiedAt || "").slice(0, 10) }
    ],
    items
  );
  logger.info(`\nShowing ${fetched} of ${total} templates.`);
}

async function templatesShow(api, id, options) {
  const template = await api.templates.get(id);

  // --html with no value prints the HTML body; --html <file> writes it to a file.
  if (options.html) {
    const html = template.htmlContent || "";
    if (options.html === true) {
      logger.info(html);
      return;
    }
    fs.writeFileSync(options.html, html);
    logger.info(`Wrote ${html.length} chars to ${options.html}.`);
    return;
  }

  if (options.json) {
    logger.info(JSON.stringify(template, null, 2));
    return;
  }

  const sender = template.sender || {};
  logger.info(`ID:        ${template.id}`);
  logger.info(`Name:      ${template.name || ""}`);
  logger.info(`Subject:   ${template.subject || ""}`);
  logger.info(`Active:    ${template.isActive ? "yes" : "no"}`);
  logger.info(`Sender:    ${sender.name ? `${sender.name} ` : ""}<${sender.email || ""}>`);
  logger.info(`Modified:  ${template.modifiedAt || ""}`);
  logger.info(`HTML:      ${(template.htmlContent || "").length} chars`);
}

async function templatesAdd(api, options) {
  if (!options.name) {
    throw new Error("templates add requires --name");
  }
  if (!options.subject) {
    throw new Error("templates add requires --subject");
  }
  if (!options.html) {
    throw new Error("templates add requires --html");
  }

  const sender = resolveSender(options);
  if (!sender) {
    throw new Error("templates add requires --sender-email (or --sender-id)");
  }

  const data = {
    templateName: options.name,
    subject: options.subject,
    htmlContent: readInput(options.html),
    sender,
    isActive: !options.inactive
  };

  const result = await api.templates.create(data);
  if (options.json) {
    logger.info(JSON.stringify(result, null, 2));
    return;
  }
  logger.info(
    `Created template "${options.name}"${result && result.id ? ` (id: ${result.id})` : ""}.`
  );
}

async function templatesEdit(api, id, options) {
  const data = {};
  if (options.name) {
    data.templateName = options.name;
  }
  if (options.subject) {
    data.subject = options.subject;
  }
  if (options.html) {
    data.htmlContent = readInput(options.html);
  }
  const sender = resolveSender(options);
  if (sender) {
    data.sender = sender;
  }
  if (options.active) {
    data.isActive = true;
  } else if (options.inactive) {
    data.isActive = false;
  }

  if (!Object.keys(data).length) {
    throw new Error(
      "templates edit needs at least one field to change (e.g. --subject, --html, --active)."
    );
  }

  await api.templates.update(id, data);
  if (options.json) {
    logger.info(
      JSON.stringify(
        {
          updated: Number(id),
          ...data,
          htmlContent: data.htmlContent ? "[updated]" : undefined
        },
        null,
        2
      )
    );
    return;
  }
  logger.info(`Updated template ${id}.`);
}

// ---- Lists -----------------------------------------------------------------

async function listsList(api, options) {
  const { items, total, fetched } = await paginate(
    query => api.contacts.lists(query),
    "lists",
    {},
    options,
    "all",
    MAX_LISTS_PAGE_SIZE
  );

  if (options.json) {
    printJson(items);
    return;
  }

  printTable(
    [
      { key: "id", header: "id", value: l => l.id || "" },
      { key: "name", header: "name", value: l => truncate(l.name, 40) },
      { key: "subscribers", header: "subscribers", value: l => l.uniqueSubscribers || 0 },
      { key: "blacklisted", header: "blacklisted", value: l => l.totalBlacklisted || 0 }
    ],
    items
  );
  logger.info(`\nShowing ${fetched} of ${total} lists.`);
}

// ---- Stats -----------------------------------------------------------------

// Transactional e-mail metrics shared by the aggregated report and the daily rows.
const STAT_METRICS = [
  { key: "requests", header: "requests", label: "Requests" },
  { key: "delivered", header: "delivered", label: "Delivered" },
  { key: "opens", header: "opens", label: "Opens" },
  { key: "uniqueOpens", header: "uniq opens", label: "Unique opens" },
  { key: "clicks", header: "clicks", label: "Clicks" },
  { key: "uniqueClicks", header: "uniq clicks", label: "Unique clicks" },
  { key: "hardBounces", header: "hard bounces", label: "Hard bounces" },
  { key: "softBounces", header: "soft bounces", label: "Soft bounces" },
  { key: "spamReports", header: "spam", label: "Spam reports" },
  { key: "unsubscribed", header: "unsub", label: "Unsubscribed" }
];

const emptyStatsDay = date =>
  STAT_METRICS.reduce((row, metric) => Object.assign(row, { [metric.key]: 0 }), { date });

async function statsAggregated(api, options) {
  const days = parsePositiveInt(options.days, "days", 30);
  const report = await api.stats.aggregated({ days });

  if (options.json) {
    printJson(report);
    return;
  }

  printFields([
    ["Range", String(report.range || "").replace("|", " .. ")],
    ...STAT_METRICS.map(metric => [metric.label, report[metric.key] || 0])
  ]);
}

async function statsDaily(api, options) {
  const days = parsePositiveInt(options.days, "days", 14);
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  const result = await api.stats.daily({ startDate: toDay(start), endDate: toDay(end) });

  // Brevo omits days without any event, fill them with zeros so they stay visible.
  const reportsByDay = new Map(((result && result.reports) || []).map(row => [row.date, row]));
  const rows = Array.from({ length: days }, (_, index) => {
    const date = toDay(new Date(start.getTime() + index * DAY_MS));
    return { ...emptyStatsDay(date), ...reportsByDay.get(date) };
  });

  if (options.json) {
    printJson(rows);
    return;
  }

  printTable(
    [
      { key: "date", header: "date", value: row => row.date },
      ...STAT_METRICS.map(metric => ({
        key: metric.key,
        header: metric.header,
        value: row => row[metric.key] || 0
      }))
    ],
    rows
  );
}

// Walk all events of one type for a template and count events and unique recipients.
// Addresses are only used for the unique count, they are never printed.
async function countTemplateEvents(api, templateId, days, event) {
  const recipients = new Set();
  let events = 0;
  let offset = 0;

  for (;;) {
    const result = await api.stats.events({
      templateId,
      days,
      event,
      limit: EVENTS_PAGE_SIZE,
      offset,
      sort: "desc"
    });
    const batch = (result && result.events) || [];
    events += batch.length;
    batch.forEach(item => recipients.add(String(item.email || "").toLowerCase()));
    offset += batch.length;
    if (batch.length < EVENTS_PAGE_SIZE) {
      break;
    }
  }

  return { event, events, uniqueRecipients: recipients.size };
}

async function statsTemplate(api, options) {
  const templateId = parsePositiveInt(options.template, "template");
  const days = parsePositiveInt(options.days, "days", 30);
  const eventNames = String(options.event || DEFAULT_TEMPLATE_EVENTS)
    .split(",")
    .map(name => name.trim())
    .filter(Boolean);

  const counts = [];
  for (const event of eventNames) {
    counts.push(await countTemplateEvents(api, templateId, days, event));
  }

  if (options.json) {
    printJson({ templateId, days, events: counts });
    return;
  }

  logger.info(`Template ${templateId}, last ${days} days:\n`);
  printTable(
    [
      { key: "event", header: "event", value: row => row.event },
      { key: "events", header: "events", value: row => row.events },
      {
        key: "uniqueRecipients",
        header: "unique recipients",
        value: row => row.uniqueRecipients
      }
    ],
    counts
  );
}

function stats(api, options) {
  if (options.template !== undefined) {
    return statsTemplate(api, options);
  }
  if (options.daily) {
    return statsDaily(api, options);
  }
  return statsAggregated(api, options);
}

// ---- Campaigns -------------------------------------------------------------

async function campaignsList(api, options) {
  const baseQuery = {
    statistics: "globalStats",
    excludeHtmlContent: true,
    sort: "desc"
  };
  if (options.status) {
    baseQuery.status = options.status;
  }

  const { items, total, fetched } = await paginate(
    query => api.campaigns.list(query),
    "campaigns",
    baseQuery,
    options,
    50,
    MAX_CAMPAIGNS_PAGE_SIZE
  );

  if (options.json) {
    printJson(items);
    return;
  }

  const globalStats = campaign =>
    (campaign.statistics && campaign.statistics.globalStats) || {};

  printTable(
    [
      { key: "id", header: "id", value: c => c.id || "" },
      { key: "name", header: "name", value: c => truncate(c.name, 30) },
      { key: "subject", header: "subject", value: c => truncate(c.subject, 40) },
      { key: "status", header: "status", value: c => c.status || "" },
      { key: "sent", header: "sent", value: c => (c.sentDate || "").slice(0, 10) },
      { key: "delivered", header: "delivered", value: c => globalStats(c).delivered || 0 },
      { key: "opens", header: "opens", value: c => globalStats(c).uniqueViews || 0 },
      { key: "clicks", header: "clicks", value: c => globalStats(c).uniqueClicks || 0 }
    ],
    items
  );
  logger.info(`\nShowing ${fetched} of ${total} campaigns.`);
}

// ---- Dispatch --------------------------------------------------------------

const COMMANDS = {
  contacts: {
    list: { run: (api, args, options) => contactsList(api, options) },
    show: {
      needsArg: "email",
      run: (api, args, options) => contactsShow(api, args[0], options)
    },
    add: {
      needsArg: "email",
      run: (api, args, options) => contactsAdd(api, args[0], options)
    },
    remove: {
      needsArg: "email",
      run: (api, args, options) => contactsRemove(api, args[0], options)
    },
    subscribe: {
      needsArg: "email",
      run: (api, args, options) => contactsSubscribe(api, args[0], options)
    },
    unsubscribe: {
      needsArg: "email",
      run: (api, args, options) => contactsUnsubscribe(api, args[0], options)
    }
  },
  templates: {
    list: { run: (api, args, options) => templatesList(api, options) },
    show: {
      needsArg: "id",
      run: (api, args, options) => templatesShow(api, args[0], options)
    },
    add: { run: (api, args, options) => templatesAdd(api, options) },
    edit: { needsArg: "id", run: (api, args, options) => templatesEdit(api, args[0], options) }
  },
  campaigns: {
    list: { run: (api, args, options) => campaignsList(api, options) }
  }
};

// Commands without a sub-command, i.e. "brevo-cli stats".
const SINGLE_COMMANDS = {
  lists: { run: (api, args, options) => listsList(api, options) },
  stats: { run: (api, args, options) => stats(api, options) }
};

async function main() {
  const { group, command, args, options } = parseArgs(process.argv.slice(2));

  if (!group || options.help) {
    logger.info(USAGE);
    return;
  }

  const singleCommand = SINGLE_COMMANDS[group];
  if (singleCommand) {
    if (command) {
      throw new Error(
        `"${group}" takes no sub-command, got "${command}". See "brevo-cli --help".`
      );
    }
    await singleCommand.run(createClient(options), args, options);
    return;
  }

  const groupCommands = COMMANDS[group];
  if (!groupCommands) {
    const groups = [...Object.keys(COMMANDS), ...Object.keys(SINGLE_COMMANDS)].join(", ");
    throw new Error(
      `Unknown group "${group}". Expected one of: ${groups}. See "brevo-cli --help".`
    );
  }

  const handler = groupCommands[command];
  if (!handler) {
    const available = Object.keys(groupCommands).join(", ");
    throw new Error(`Unknown command "${group} ${command || ""}". Available: ${available}.`);
  }

  if (handler.needsArg && !args[0]) {
    throw new Error(`"${group} ${command}" requires a <${handler.needsArg}> argument.`);
  }

  const api = createClient(options);
  await handler.run(api, args, options);
}

main().catch(err => {
  logger.error(`Error: ${err.message}`);
  process.exit(1);
});
