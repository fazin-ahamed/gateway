import test from "node:test";
import assert from "node:assert/strict";
import { repairJson } from "../src/json-repair.js";

test("valid JSON comes back byte-for-byte with no fixes", () => {
  const raw = '{ "a" : 1,\n "b":[1, 2 ] }';
  const r = repairJson(raw);
  assert.equal(r.ok, true);
  assert.equal(r.text, raw);
  assert.deepEqual(r.fixes, []);
});

const cases = [
  ["code fence", '```json\n{"path":"a.js"}\n```', { path: "a.js" }, "code_fence"],
  ["trailing comma", '{"a":1,"b":[1,2,],}', { a: 1, b: [1, 2] }, "trailing_comma"],
  ["single quotes", "{'path': 'a.js', 'n': 2}", { path: "a.js", n: 2 }, "single_quotes"],
  ["unquoted keys", '{path: "a.js", count: 3}', { path: "a.js", count: 3 }, "unquoted_key"],
  ["python literals", '{"a": True, "b": False, "c": None}', { a: true, b: false, c: null }, "python_literal"],
  ["line comment", '{"a": 1, // note\n "b": 2}', { a: 1, b: 2 }, "comment"],
  ["block comment", '{"a": /* x */ 1}', { a: 1 }, "comment"],
  ["leading prose", 'Here is the call: {"a": 1}', { a: 1 }, "leading_text"],
  ["trailing prose", '{"a": 1} hope that helps', { a: 1 }, "trailing_text"],
  ["missing comma", '{"a": 1 "b": 2}', { a: 1, b: 2 }, "missing_comma"],
  ["raw newline in string", '{"text": "line1\nline2"}', { text: "line1\nline2" }, "raw_control_char"]
];
for (const [name, input, expected, fix] of cases) {
  test("repairs " + name, () => {
    const r = repairJson(input);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, expected);
    assert.ok(r.fixes.includes(fix), "fixes " + r.fixes.join(",") + " should include " + fix);
    assert.deepEqual(JSON.parse(r.text), expected, "output text is strict JSON");
  });
}

test("truncated objects, arrays and strings are closed and flagged", () => {
  let r = repairJson('{"path":"a.js","content":"hello wor');
  assert.deepEqual(r.value, { path: "a.js", content: "hello wor" });
  assert.equal(r.closed, true);
  assert.ok(r.fixes.includes("truncated_closed"));

  r = repairJson('{"items":[1,2,');
  assert.deepEqual(r.value, { items: [1, 2] });
  assert.equal(r.closed, true);

  r = repairJson('{"a":1,"b":');
  assert.deepEqual(r.value, { a: 1 }, "a key whose value never arrived is dropped, not nulled");
  assert.equal(r.closed, true);
});

test("hopeless input is reported, not guessed", () => {
  assert.equal(repairJson("").ok, false);
  assert.equal(repairJson("no braces here at all").ok, false);
});
