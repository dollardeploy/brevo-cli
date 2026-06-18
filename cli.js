#!/usr/bin/env node

const fs = require("fs");

const BrevoAPI = require("./api");

const logger = console;

// Brevo allows up to 1000 records per list request.
const MAX_PAGE_SIZE = 1000;

// Flags that never take a value.
const BOOLEAN_FLAGS = new Set(["json", "active", "inactive", "update"]);

const USAGE = `brevo-cli — manage Brevo contacts and transactional templates from the command line

Usage:
  brevo-cli <group> <command> [arguments] [options]

Contact commands:
  contacts list                    List contacts (auto-paginates over 1000 / "all")
  contacts add <email>             Create a contact
  contacts remove <email>          Delete a contact permanently
  contacts subscribe <email>       Re-subscribe (emailBlacklisted = false)
  contacts unsubscribe <email>     Unsubscribe (emailBlacklisted = true)

Template commands (transactional / automated emails):
  templates list                   List transactional email templates
  templates show <id>              Show a template (--html prints/writes its body)
  templates add --name "..."       Create a template
  templates edit <id>              Update a template

Connection options:
  --key <api-key>                  Brevo API key (default: BREVO_API_KEY)
  --url <base-url>                 API base URL (default: BREVO_API_URL or https://api.brevo.com/v3)

Contact options:
  --attrs "K=V,K2=V2"              [add] Contact attributes (keys upper-cased, e.g. FIRSTNAME=Jane)
  --list <id1,id2>                 [add] List IDs to add the contact to
  --no-subscribe                   [add] Create the contact already unsubscribed
  --update                         [add] Update the contact if it already exists
  --limit <n|all>                  [list] How many to return (default 50)
  --offset <n>                     [list] Starting offset (default 0)

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
async function paginate(listFn, key, baseQuery, options, defaultLimit) {
  const limit = options.limit || defaultLimit;
  const fetchAll = limit === "all";
  const target = fetchAll ? Infinity : Number(limit);

  const collected = [];
  let offset = options.offset ? Number(options.offset) : 0;
  let total = 0;

  while (collected.length < target) {
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      fetchAll ? MAX_PAGE_SIZE : target - collected.length
    );
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
  const { items, total, fetched } = await paginate(
    query => api.contacts.list(query),
    "contacts",
    {},
    options,
    50
  );

  if (options.json) {
    logger.info(JSON.stringify(items, null, 2));
    return;
  }

  printTable(
    [
      { key: "email", header: "email", value: c => c.email || "" },
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

// ---- Dispatch --------------------------------------------------------------

const COMMANDS = {
  contacts: {
    list: { run: (api, args, options) => contactsList(api, options) },
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
  }
};

async function main() {
  const { group, command, args, options } = parseArgs(process.argv.slice(2));

  if (!group || options.help) {
    logger.info(USAGE);
    return;
  }

  const groupCommands = COMMANDS[group];
  if (!groupCommands) {
    throw new Error(
      `Unknown group "${group}". Expected "contacts" or "templates". See "brevo-cli --help".`
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
