// Deterministic repair of model-emitted JSON, used for tool-call arguments.
//
// Contract: valid JSON is returned byte-for-byte (`fixes` empty). Anything
// else is scanned once by a tolerant tokenizer that re-emits strict JSON and
// records which kinds of damage it fixed. Nothing is invented: a truncated
// value is closed structurally (quotes, brackets) but a missing value after a
// key becomes null only when the key itself was complete, and callers that
// must never execute a cut-off call check `closed` and drop it instead.

const FENCE = /^\s*```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```\s*$/;

export function repairJson(input) {
  const raw = input == null ? "" : String(input);
  try {
    const value = JSON.parse(raw);
    return { ok: true, text: raw, value, fixes: [], closed: false };
  } catch {}

  const fixes = new Set();
  let src = raw;
  const fenced = FENCE.exec(src);
  if (fenced) { src = fenced[1]; fixes.add("code_fence"); }
  src = src.trim();
  if (!src) return { ok: false, text: raw, value: undefined, fixes: [], closed: false };

  const p = new Parser(src, fixes);
  let value;
  try {
    value = p.parseTop();
  } catch {
    return { ok: false, text: raw, value: undefined, fixes: [...fixes], closed: false };
  }
  const text = JSON.stringify(value);
  if (p.closed) fixes.add("truncated_closed");
  if (fixes.size === 0) fixes.add("json_syntax");
  else if (!fixes.has("truncated_closed") && !fixes.has("code_fence")) fixes.add("json_syntax");
  return { ok: true, text, value, fixes: [...fixes], closed: p.closed };
}

class Parser {
  constructor(src, fixes) {
    this.s = src;
    this.i = 0;
    this.fixes = fixes;
    this.closed = false;
  }

  eof() { return this.i >= this.s.length; }

  ws() {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\n" || c === "\t" || c === "\r") { this.i++; continue; }
      if (c === "/" && this.s[this.i + 1] === "/") {
        while (!this.eof() && this.s[this.i] !== "\n") this.i++;
        this.fixes.add("comment");
        continue;
      }
      if (c === "/" && this.s[this.i + 1] === "*") {
        const end = this.s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
        this.fixes.add("comment");
        continue;
      }
      return;
    }
  }

  parseTop() {
    // Tolerate prose before the first brace or bracket ("Here is the call: {...}").
    this.ws();
    const c = this.s[this.i];
    if (c !== "{" && c !== "[" && c !== '"' && c !== "'" && !/[-0-9tfnTFN]/.test(c || "")) {
      const o = this.s.search(/[{[]/);
      if (o < 0) throw new Error("no json");
      this.i = o;
      this.fixes.add("leading_text");
    }
    const start = this.s[this.i];
    const v = this.value();
    // A bare word at the top level is prose, not a value to execute.
    if (typeof v === "string" && start !== '"' && start !== "'") throw new Error("not json");
    this.ws();
    if (!this.eof()) this.fixes.add("trailing_text");
    return v;
  }

  value() {
    this.ws();
    if (this.eof()) { this.closed = true; return null; }
    const c = this.s[this.i];
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'") return this.string();
    return this.bare();
  }

  object() {
    this.i++;
    const out = {};
    let afterComma = false;
    for (;;) {
      this.ws();
      if (this.eof()) { this.closed = true; return out; }
      let c = this.s[this.i];
      if (c === "}") { if (afterComma) this.fixes.add("trailing_comma"); this.i++; return out; }
      if (c === ",") { this.i++; this.fixes.add("trailing_comma"); continue; }
      afterComma = false;
      const key = this.key();
      this.ws();
      if (this.eof()) { this.closed = true; return out; }
      if (this.s[this.i] === ":" || this.s[this.i] === "=") {
        if (this.s[this.i] === "=") this.fixes.add("json_syntax");
        this.i++;
      } else {
        this.fixes.add("missing_colon");
      }
      this.ws();
      if (this.eof()) { this.closed = true; return out; }
      const v = this.value();
      out[key] = v;
      this.ws();
      if (this.eof()) { this.closed = true; return out; }
      c = this.s[this.i];
      if (c === ",") { this.i++; afterComma = true; continue; }
      if (c === "}") { this.i++; return out; }
      this.fixes.add("missing_comma");
    }
  }

  array() {
    this.i++;
    const out = [];
    let afterComma = false;
    for (;;) {
      this.ws();
      if (this.eof()) { this.closed = true; return out; }
      let c = this.s[this.i];
      if (c === "]") { if (afterComma) this.fixes.add("trailing_comma"); this.i++; return out; }
      if (c === ",") { this.i++; this.fixes.add("trailing_comma"); continue; }
      afterComma = false;
      out.push(this.value());
      this.ws();
      if (this.eof()) { this.closed = true; return out; }
      c = this.s[this.i];
      if (c === ",") { this.i++; afterComma = true; continue; }
      if (c === "]") { this.i++; return out; }
      this.fixes.add("missing_comma");
    }
  }

  key() {
    const c = this.s[this.i];
    if (c === '"' || c === "'") return this.string();
    const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(this.s.slice(this.i));
    if (!m) throw new Error("bad key");
    this.i += m[0].length;
    this.fixes.add("unquoted_key");
    return m[0];
  }

  string() {
    const quote = this.s[this.i++];
    if (quote === "'") this.fixes.add("single_quotes");
    let out = "";
    for (;;) {
      if (this.eof()) { this.closed = true; return out; }
      const c = this.s[this.i++];
      if (c === quote) return out;
      if (c === "\\") {
        if (this.eof()) { this.closed = true; return out; }
        const n = this.s[this.i++];
        const map = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"', "'": "'" };
        if (n === "u") {
          const hex = this.s.slice(this.i, this.i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); this.i += 4; }
          else { this.closed = this.closed || this.i + 4 > this.s.length; out += "\\u"; }
        } else if (n in map) out += map[n];
        else { out += n; this.fixes.add("bad_escape"); }
        continue;
      }
      if (c === "\n" || c === "\r" || c === "\t") {
        // Raw control characters inside a string are common; JSON forbids them.
        this.fixes.add("raw_control_char");
      }
      out += c;
    }
  }

  bare() {
    const m = /^[^\s,\]}:]+/.exec(this.s.slice(this.i));
    if (!m) throw new Error("bad value");
    const tok = m[0];
    this.i += tok.length;
    if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok);
    const lower = tok.toLowerCase();
    if (tok === "true" || tok === "false" || tok === "null") return JSON.parse(tok);
    if (lower === "true") { this.fixes.add("python_literal"); return true; }
    if (lower === "false") { this.fixes.add("python_literal"); return false; }
    if (lower === "none" || lower === "null" || lower === "undefined" || lower === "nan" || lower === "infinity" || lower === "-infinity") { this.fixes.add("python_literal"); return null; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(tok)) { this.fixes.add("json_syntax"); return Number(tok); }
    // An unquoted word: keep it as text rather than guessing.
    this.fixes.add("unquoted_value");
    return tok;
  }
}
