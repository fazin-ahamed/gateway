// Wave 2: json-repair unquoted_value guards and tool-schema robustness.

import test from "node:test";
import assert from "node:assert/strict";
import { repairJson } from "../src/json-repair.js";
import { coerce, validate } from "../src/tool-schema.js";

// ---- json-repair: unquoted_value guards ----

test("Python booleans are coerced, not kept as strings", () => {
  const r = repairJson('{"ok": True, "bad": False, "missing": None}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { ok: true, bad: false, missing: null });
  assert.ok(r.fixes.includes("python_literal"));
});

test("a bare word at the top level is never executed as a tool call", () => {
  const r = repairJson("delete_everything");
  assert.equal(r.ok, false, "a bare word is prose, not a value to execute");
});

test("stray text after a valid object is reported, not silently dropped", () => {
  const r = repairJson('{"a": 1} and also this junk');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { a: 1 });
  assert.ok(r.fixes.includes("trailing_text"));
});

test("leading prose before the object is skipped", () => {
  const r = repairJson('Here is the call: {"path": "a.js"}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { path: "a.js" });
  assert.ok(r.fixes.includes("leading_text"));
});

test("nested double quotes inside a single-quoted string survive", () => {
  const r = repairJson(`{'msg': 'she said "hello" to me'}`);
  assert.equal(r.ok, true);
  assert.equal(r.value.msg, 'she said "hello" to me');
});

test("an unquoted string value is kept as text, not guessed into a type", () => {
  const r = repairJson('{"name": some_file.txt}');
  assert.equal(r.ok, true);
  assert.equal(r.value.name, "some_file.txt");
  assert.ok(r.fixes.includes("unquoted_value"));
});

test("NaN and Infinity become null, never a number", () => {
  const r = repairJson('{"x": NaN, "y": Infinity}');
  assert.equal(r.ok, true);
  assert.equal(r.value.x, null);
  assert.equal(r.value.y, null);
});

// ---- tool-schema: robustness ----

test("allOf merges constraints from every branch", () => {
  const schema = {
    allOf: [
      { type: "object", properties: { a: { type: "string" } } },
      { type: "object", required: ["b"], properties: { b: { type: "integer" } } }
    ]
  };
  const errors = validate({ a: "x" }, schema);
  assert.ok(errors.some((e) => e.includes("b") && e.includes("required")), "missing b from the second branch");
});

test("$ref resolves local definitions", () => {
  const schema = {
    type: "object",
    properties: { file: { $ref: "#/$defs/path" }, n: { $ref: "#/$defs/num" } },
    $defs: { path: { type: "string" }, num: { type: "integer" } }
  };
  assert.equal(validate({ file: "a.js", n: 3 }, schema).length, 0);
  // A string that cannot coerce to integer fails the $ref target.
  assert.ok(validate({ file: "a.js", n: "three" }, schema).length > 0, "an uncoercible string fails the $ref integer schema");
});

test("nullable fields accept null without coercion", () => {
  const schema = { type: "object", properties: { v: { type: ["string", "null"] } } };
  assert.equal(validate({ v: null }, schema).length, 0);
});

test("integer coercion accepts a whole float string, never truncates a fraction", () => {
  const schema = { type: "object", properties: { n: { type: "integer" } } };
  const whole = coerce({ n: "5" }, schema);
  assert.equal(whole.value.n, 5, "'5' coerces to 5");
  assert.ok(whole.fixes.includes("type_coercion"));
  const frac = coerce({ n: 5.7 }, schema);
  assert.equal(frac.value.n, 5.7, "5.7 is left alone");
  assert.ok(frac.errors.length > 0, "5.7 is not an integer");
  const fracStr = coerce({ n: "5.7" }, schema);
  assert.equal(fracStr.value.n, "5.7", "'5.7' is not coerced to 5");
  assert.ok(fracStr.errors.length > 0, "'5.7' is not an integer");
});

test("required fields are never invented, only defaulted or reported", () => {
  const schema = {
    type: "object",
    required: ["path", "mode"],
    properties: {
      path: { type: "string" },
      mode: { type: "string", default: "read" }
    }
  };
  const r = coerce({}, schema);
  assert.equal(r.value.mode, "read", "default fills in");
  assert.ok(r.fixes.includes("required_default"));
  assert.ok(r.errors.some((e) => e.includes("path") && e.includes("required")), "path with no default is an error, never invented");
});

test("pattern validates string format", () => {
  const schema = { type: "object", properties: { email: { type: "string", pattern: "^[^@]+@[^@]+$" } } };
  assert.equal(validate({ email: "a@b.c" }, schema).length, 0);
  assert.ok(validate({ email: "not-an-email" }, schema).length > 0);
});

test("minimum and maximum bound numbers", () => {
  const schema = { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 10 } } };
  assert.equal(validate({ n: 5 }, schema).length, 0);
  assert.ok(validate({ n: 0 }, schema).length > 0);
  assert.ok(validate({ n: 11 }, schema).length > 0);
});

test("minItems and maxItems bound arrays", () => {
  const schema = { type: "object", properties: { tags: { type: "array", minItems: 1, maxItems: 3 } } };
  assert.equal(validate({ tags: ["a"] }, schema).length, 0);
  assert.ok(validate({ tags: [] }, schema).length > 0);
  assert.ok(validate({ tags: ["a", "b", "c", "d"] }, schema).length > 0);
});
