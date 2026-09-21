// Failure signature normalization.
//
// Turns a raw error into a reusable fingerprint so a repeated class of
// problem immediately recalls a previously verified fix strategy.
// Compiler errors are the easy case (stable codes); stack traces need the
// symbol and file lifted out of the noise.

const CODE_PATTERNS = [
  // Languages and tools with stable error codes.
  /\b(TS\d{4})\b/,                                  // TypeScript
  /\b(ESLint| eslint)\/([a-z-]+)\b/i,               // ESLint rules
  /\b(EADDRINUSE|ECONNRESET|EACCES|ENOENT|EEXIST|EMFILE|ENOTEMPTY|EPERM|ETIMEDOUT|EAI_AGAIN|UNDEFINED|SELF_SIGNED_CERT_IN_CHAIN)\b/,
  /\b(SQLITE_BUSY|SQLITE_CONSTRAINT|SQLITE_CANTOPEN|SQLITE_CORRUPT|SQLITE_READONLY)\b/,
  /\b(Permission denied|command not found|no such file|module not found|Cannot find module)\b/i,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError)\b/,
  /\b(HTTP 4\d\d|HTTP 5\d\d)\b/
];

const STACK_FRAME = /at\s+(?:([\w.]+)\s+)?\(?(?:file:\/\/)?([^():\s]+):(\d+):(\d+)\)?/;

export function normalizeFailure(rawError) {
  const text = String(rawError || "");
  if (!text)
    return null;

  const sig = { fingerprint: null, errorClass: null, symbol: null, file: null, raw: text.slice(0, 2000) };

  // Stable code first: it is the most reusable key.
  for (const re of CODE_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      sig.errorClass = m[1] || m[0];
      sig.fingerprint = String(sig.errorClass).toUpperCase();
      break;
    }
  }

  // Stack frame: lift symbol + file out of the line numbers, which vary
  // between runs and would fragment the fingerprint.
  const frame = STACK_FRAME.exec(text);
  if (frame) {
    if (frame[1]) sig.symbol = frame[1];
    if (frame[2]) {
      // Keep the repo-relative path shape; drop absolute prefixes but
      // preserve the first segment (ai-gateway/, relay/...) so the key
      // still names which repo the file is in.
      const raw = String(frame[2]);
      const isAbs = /^[\\/]/.test(raw);
      // Absolute path: keep the last two segments (repo/dir/...) so the key
      // still names which repo the file is in. Relative: use verbatim.
      sig.file = isAbs
        ? raw.split(/[\\/]/).slice(-2).join("/")
        : raw;
    }
  }

  // A TypeError without a frame still names the operation.
  if (!sig.fingerprint && /\bTypeError:/.test(text)) {
    const op = text.match(/TypeError:\s*(.*)/);
    sig.errorClass = "TypeError";
    sig.fingerprint = op && op[1]
      ? "TYPEERROR:" + op[1].replace(/['"]/g, "").split(/\s+/).slice(0, 4).join(" ").toUpperCase()
      : "TYPEERROR";
  }

  if (!sig.fingerprint) {
    // Last resort: the leading clause, normalized. Better than nothing for
    // recall, deliberately coarse. Strip volatile fragments (line numbers,
    // hex ids, paths) so the key stays stable across runs — a fingerprint
    // that fragments on every occurrence defeats the whole point.
    const head = text.split(String.fromCharCode(10))[0]
      .replace(/[`'"]/g, "")
      .replace(/:\d+:\d+(\)|\s|$)/g, "$1")
      .replace(/\b[0-9a-f]{8,}\b/gi, "")
      .replace(/[/\\][^)\s]*/g, "")
      .trim();
    sig.errorClass = "uncoded";
    sig.fingerprint = "UNCODED:" + head.slice(0, 80).toUpperCase();
  }

  if (sig.symbol && sig.file)
    sig.fingerprint += "@" + sig.symbol;
  return sig;
}

// Anticipatory triggers generated from a verified episode — the T-Mem idea
// that matters most. Templates over structured fields, no LLM required.
export function generateTriggers(episode) {
  if (!episode)
    return [];
  const out = [];
  const sig = episode.errorSignature || null;

  if (sig) {
    out.push({ kind: "failure", phrase: sig.errorClass || "", weight: 1.0 });
    if (sig.symbol)
      out.push({ kind: "symbol", phrase: sig.symbol, weight: 0.9 });
    if (sig.file)
      out.push({ kind: "file", phrase: sig.file, weight: 0.8 });
  }
  if (episode.scope)
    out.push({ kind: "scope", phrase: episode.scope, weight: 0.7 });
  if (episode.task)
    out.push({ kind: "task", phrase: episode.task, weight: 0.6 });
  if (Array.isArray(episode.files))
    for (const f of episode.files)
      out.push({ kind: "file", phrase: f, weight: 0.5 });
  if (Array.isArray(episode.symbols))
    for (const s of episode.symbols)
      out.push({ kind: "symbol", phrase: s, weight: 0.5 });
  if (episode.technique)
    out.push({ kind: "technique", phrase: episode.technique, weight: 0.4 });

  return out
    .filter((t) => t.phrase && String(t.phrase).trim())
    .filter((t, i, arr) => arr.findIndex((x) => x.kind === t.kind && x.phrase === t.phrase) === i);
}
