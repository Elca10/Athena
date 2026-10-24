// Only this computer's own browser tab may use the API. Binding to
// 127.0.0.1 (config.js) keeps other machines out, but not other websites:
// any page open in the same browser can send requests to localhost.
//   - DNS rebinding: a site's own hostname re-resolved to 127.0.0.1 makes
//     its requests same-origin, so the browser lets it read every answer.
//     The Host header still names that site, so every request must name a
//     loopback host.
//   - Cross-site requests: a form or no-cors fetch can POST here without
//     reading the reply (start an update, a model turn, a bug report).
//     Browsers send Origin on every non-GET request and Sec-Fetch-Site on
//     most, so a state-changing request from another site is refused.
// GETs from another site are fine: following a link to Athena is a GET,
// and the browser won't hand another site the answer without CORS headers,
// which this server never sends. Requests with no Origin at all (curl, the
// installers' health check, tests) aren't from a web page, so they pass.

import { HOST } from "./config.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isAllowedHostname(hostname, extraHost = HOST) {
  const name = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(name) || name === extraHost.toLowerCase();
}

/** The hostname part of a Host header ("localhost:4417", "[::1]:4417"). */
function hostnameOf(hostHeader) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(hostHeader.trim());
  return match ? match[1] : null;
}

/** Why `req` must be refused, or null when it's allowed. Pure, for tests. */
export function refusalReason({ method, headers }, { extraHost = HOST } = {}) {
  const hostname = hostnameOf(headers.host ?? "");
  if (!hostname || !isAllowedHostname(hostname, extraHost)) return "host";
  if (SAFE_METHODS.has(method)) return null;

  const site = headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return "cross-site";
  const origin = headers.origin;
  if (origin === undefined) return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return "origin"; // includes the literal "null" a sandboxed page sends
  }
  // Athena's own page sends exactly its own scheme, host and port; another
  // local app on a different port is a different site.
  if (url.protocol !== "http:" || url.host !== headers.host.trim().toLowerCase()) return "origin";
  return null;
}

export function localOnly(req, res, next) {
  if (refusalReason(req)) {
    res.status(403).json({ error: "Athena only accepts requests from its own page on this computer." });
    return;
  }
  next();
}
