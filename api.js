const packageInfo = require("./package.json");

const DEFAULT_BASE_URL = "https://api.brevo.com/v3";

/**
 * A tiny, dependency-free client for the Brevo API (https://developers.brevo.com).
 * Authenticates with the `api-key` header and transports everything over the
 * native `fetch`.
 *
 * @param {Object} options
 * @param {String} options.apiKey - Brevo API v3 key (starts with `xkeysib-`)
 * @param {String} [options.baseUrl] - override the API base URL
 */
function BrevoAPI(options = {}) {
  const apiKey = options.apiKey;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  if (!apiKey) {
    throw new Error("BrevoAPI: apiKey is required");
  }

  function buildQuery(query = {}) {
    const parts = Object.keys(query)
      .filter(key => query[key] !== undefined && query[key] !== null && query[key] !== "")
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`);
    return parts.length ? `?${parts.join("&")}` : "";
  }

  async function request(method, path, { query, body } = {}) {
    const url = `${baseUrl}${path}${buildQuery(query)}`;

    const headers = {
      "api-key": apiKey,
      accept: "application/json",
      "user-agent": `dollardeploy-brevo-cli/${packageInfo.version}`
    };

    const fetchOptions = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    const rawBody = await response.text();
    let parsedBody;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch (e) {
        parsedBody = rawBody;
      }
    }

    if (!response.ok) {
      const message =
        parsedBody && parsedBody.message
          ? parsedBody.message
          : `Request failed with status code ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      if (parsedBody && parsedBody.code) {
        error.code = parsedBody.code;
      }
      error.response = { status: response.status, data: parsedBody };
      throw error;
    }

    return parsedBody;
  }

  const encode = identifier => encodeURIComponent(String(identifier));

  return {
    request,

    account: {
      get: () => request("GET", "/account")
    },

    contacts: {
      list: query => request("GET", "/contacts", { query }),
      get: identifier => request("GET", `/contacts/${encode(identifier)}`),
      create: data => request("POST", "/contacts", { body: data }),
      update: (identifier, data) =>
        request("PUT", `/contacts/${encode(identifier)}`, { body: data }),
      remove: identifier => request("DELETE", `/contacts/${encode(identifier)}`)
    },

    templates: {
      list: query => request("GET", "/smtp/templates", { query }),
      get: id => request("GET", `/smtp/templates/${encode(id)}`),
      create: data => request("POST", "/smtp/templates", { body: data }),
      update: (id, data) => request("PUT", `/smtp/templates/${encode(id)}`, { body: data })
    }
  };
}

module.exports = BrevoAPI;
