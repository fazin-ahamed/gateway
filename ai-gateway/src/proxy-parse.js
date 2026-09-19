// Strict proxy line parser / normalizer / deduper for the proxy pool importer.
//
// Never guesses a malformed entry. Every input line is either accepted (with a
// canonical {scheme, host, port, username, password}) or reported invalid.
// Identity is scheme|host|port|username so the same host on two schemes or two
// accounts stays distinct.

const SCHEMES = new Set(["http", "https", "socks5", "socks5h"]);

function normHost(host) {
  const h = String(host || "").trim().toLowerCase();
  // Strip IPv6 brackets for storage; re-added at dial time.
  if (h.startsWith("[") && h.endsWith("]"))
    return h.slice(1, -1);
  return h;
}

function validPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function validHost(host) {
  if (!host) return false;
  if (host.length > 255) return false;
  // IPv4 / IPv6 / hostname — reject spaces, slashes, @, and control chars.
  return !/[\s/@\\]/.test(host);
}

export function proxyIdentity(p) {
  return [p.scheme, p.host, p.port, p.username || ""].join("|");
}

// Parse a single line. Returns { ok, proxy } or { ok:false, reason }.
export function parseProxyLine(raw, defaultScheme = "http") {
  const line = String(raw || "").trim();
  if (!line || line.startsWith("#"))
    return { ok: false, reason: "blank" };

  // URI form: scheme://[user:pass@]host:port
  if (/^[a-z0-9]+:\/\//i.test(line)) {
    let u;
    try {
      u = new URL(line);
    } catch {
      return { ok: false, reason: "malformed_url" };
    }
    const scheme = u.protocol.replace(/:$/, "").toLowerCase();
    if (!SCHEMES.has(scheme))
      return { ok: false, reason: "unsupported_scheme" };
    if ((u.pathname && u.pathname !== "/") || u.search || u.hash)
      return { ok: false, reason: "unexpected_path" };
    const host = normHost(u.hostname);
    const port = Number(u.port) || defaultPort(scheme);
    if (!validHost(host)) return { ok: false, reason: "bad_host" };
    if (!validPort(port)) return { ok: false, reason: "bad_port" };
    const username = decodeURIComponent(u.username || "");
    const password = decodeURIComponent(u.password || "");
    if (username.length > 255 || password.length > 255)
      return { ok: false, reason: "credential_too_long" };
    return { ok: true, proxy: { scheme, host, port, username, password } };
  }

  // Bare forms. Support host:port and the unambiguous host:port:user:pass dump
  // format. Anything else is invalid — never guess.
  const parts = line.split(":");
  if (parts.length === 2) {
    const host = normHost(parts[0]);
    const port = Number(parts[1]);
    if (!validHost(host)) return { ok: false, reason: "bad_host" };
    if (!validPort(port)) return { ok: false, reason: "bad_port" };
    return { ok: true, proxy: { scheme: defaultScheme, host, port, username: "", password: "" } };
  }
  if (parts.length === 4) {
    const host = normHost(parts[0]);
    const port = Number(parts[1]);
    const username = parts[2];
    const password = parts[3];
    if (!validHost(host)) return { ok: false, reason: "bad_host" };
    if (!validPort(port)) return { ok: false, reason: "bad_port" };
    if (!username) return { ok: false, reason: "bad_credentials" };
    if (username.length > 255 || password.length > 255)
      return { ok: false, reason: "credential_too_long" };
    return { ok: true, proxy: { scheme: defaultScheme, host, port, username, password } };
  }
  return { ok: false, reason: "unrecognized_format" };
}

function defaultPort(scheme) {
  if (scheme === "http") return 80;
  if (scheme === "https") return 443;
  return 1080; // socks5/socks5h
}

// Parse a whole import blob. Returns accepted proxies (deduped within the
// batch), a duplicate count, and the invalid lines with reasons. Blank/comment
// lines are ignored, not counted as invalid.
export function parseProxyImport(text, defaultScheme = "http") {
  const lines = String(text || "").split(/\r?\n/);
  const accepted = [];
  const seen = new Set();
  const invalid = [];
  let duplicates = 0;
  for (const raw of lines) {
    const r = parseProxyLine(raw, defaultScheme);
    if (!r.ok) {
      if (r.reason === "blank")
        continue;
      invalid.push({ line: raw.trim().slice(0, 120), reason: r.reason });
      continue;
    }
    const id = proxyIdentity(r.proxy);
    if (seen.has(id)) {
      duplicates++;
      continue;
    }
    seen.add(id);
    accepted.push(r.proxy);
  }
  return { accepted, duplicates, invalid };
}

// Display form that never reveals the password.
export function maskProxy(p) {
  const auth = p.username ? p.username + ":\u2022\u2022\u2022@" : "";
  const host = p.host.includes(":") ? "[" + p.host + "]" : p.host;
  return p.scheme + "://" + auth + host + ":" + p.port;
}
