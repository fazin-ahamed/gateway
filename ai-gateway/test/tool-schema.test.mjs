import test from "node:test";
import assert from "node:assert/strict";
import { coerce, validate } from "../src/tool-schema.js";

const schema = {
  type: "object",
  required: ["path", "limit"],
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    limit: { type: "integer", default: 100 },
    recursive: { type: "boolean" },
    mode: { type: "string", enum: ["fast", "Deep"] },
    tags: { type: "array", items: { type: "string" } },
    opts: { type: "object", properties: { depth: { type: "number" } } }
  }
};

test("coerces numeric and boolean strings and snaps enum spellings", () => {
  const r = coerce({ path: "a", limit: "25", recursive: "TRUE", mode: "deep" }, schema);
  assert.deepEqual(r.value, { path: "a", limit: 25, recursive: true, mode: "Deep" });
  assert.deepEqual([...new Set(r.fixes)].sort(), ["enum_snap", "type_coercion"]);
  assert.deepEqual(r.errors, []);
});

test("wraps a scalar into an array and parses double-encoded objects", () => {
  const r = coerce({ path: "a", limit: 1, tags: "x", opts: '{"depth":"3"}' }, schema);
  assert.deepEqual(r.value.tags, ["x"]);
  assert.deepEqual(r.value.opts, { depth: 3 });
});

test("drops unknown properties only when additionalProperties is false", () => {
  const strict = coerce({ path: "a", limit: 1, extra: 1 }, schema);
  assert.equal("extra" in strict.value, false);
  assert.ok(strict.fixes.includes("unknown_prop_dropped"));
  const open = coerce({ path: "a", extra: 1 }, { type: "object", properties: { path: { type: "string" } } });
  assert.equal(open.value.extra, 1);
});

test("fills a required field only from a declared default; otherwise reports it", () => {
  const r = coerce({ path: "a" }, schema);
  assert.equal(r.value.limit, 100);
  assert.ok(r.fixes.includes("required_default"));
  const missing = coerce({ limit: 1 }, schema);
  assert.ok(missing.errors.some((e) => /path.*required/.test(e)));
  assert.equal("path" in missing.value, false, "never invents a value");
});

test("does not coerce ambiguous values", () => {
  assert.ok(validate({ path: "a", limit: "2.5" }, schema).length > 0, "2.5 is not an integer");
  assert.ok(validate({ path: "a", limit: 1, mode: "medium" }, schema).length > 0, "unknown enum member stays an error");
});

test("anyOf picks the first alternative that fits", () => {
  const s = { anyOf: [{ type: "integer" }, { type: "string", enum: ["all"] }] };
  assert.equal(coerce("7", s).value, 7);
  assert.equal(coerce("all", s).value, "all");
  assert.ok(coerce("nope", s).errors.length > 0);
});
