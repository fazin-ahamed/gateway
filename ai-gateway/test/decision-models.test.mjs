// Decision models are ordinary routes with a different wire format. These
// tests pin the contract that keeps them from contaminating chat routing.

import test from "node:test";
import assert from "node:assert/strict";

import { validateRequest, validateQuestion, normalizeAnswer, normalizeChoice, normalizeScore, normalizeNoul } from "../src/decision/types.js";
import { mapSystemOneResponse, isSystemOneFormat, systemOnePath } from "../src/decision/providers/systemone.js";
import { buildCapabilityEnvelope } from "../src/router/capability-envelope.js";

test("the request contract requires state and at least one typed question", () => {
  assert.match(validateRequest({}), /state/);
  assert.match(validateRequest({ state: {} }), /question/);
  assert.equal(validateRequest({ state: {}, questions: { a: { type: "noul", instructions: "x" } } }), null);
  assert.match(validateRequest({ state: {}, questions: { a: { type: "bogus" } } }), /choice, score or noul/);
  assert.match(validateQuestion("a", { type: "choice" }), /criteria/);
  assert.match(validateQuestion("a", { type: "score", criteria: ["only"] }), /at least two/);
  assert.match(validateQuestion("a", { type: "noul" }), /instructions/);
});

test("a choice answer cannot invent an option outside the gateway's set", () => {
  const question = { type: "choice", criteria: { fast: "quick", strong: "deep" } };
  const good = normalizeChoice(question, { choice: "strong", probabilities: { fast: 0.1, strong: 0.9 }, confidence: 0.8 });
  assert.equal(good.choice, "strong");
  const invented = normalizeChoice(question, { choice: "claude-opus", probabilities: { fast: 0.1, strong: 0.9 } });
  assert.equal(invented.choice, null, "an invented model name is dropped, never passed through");
  const foreignProb = normalizeChoice(question, { choice: "fast", probabilities: { fast: 0.5, strong: 0.5, claude: 0.9 } });
  assert.equal(foreignProb.probabilities.claude, undefined, "probabilities are restricted to the offered options");
});

test("choice probabilities normalize to a unit distribution", () => {
  const question = { type: "choice", criteria: { a: "", b: "", c: "" } };
  const out = normalizeChoice(question, { choice: "b", probabilities: { a: 2, b: 4, c: 2 } });
  assert.equal(out.probabilities.a + out.probabilities.b + out.probabilities.c, 1);
});

test("a score is bounded to its criteria scale and labelled", () => {
  const question = { type: "score", criteria: ["easy", "normal", "hard", "very hard"] };
  const out = normalizeScore(question, { score: 2.7, confidence: 0.7 });
  assert.equal(out.label, "very hard", "2.7 rounds to index 3, the top label");
  assert.equal(normalizeScore(question, { score: 99 }).score, 3, "clamped to the top of the scale");
  assert.equal(normalizeScore(question, {}).score, null);
});

test("a noul answer is a probability in [0,1] from either fraction or percent", () => {
  const q = { type: "noul", instructions: "x" };
  assert.equal(normalizeNoul(q, { probability: 0.96 }).probability, 0.96);
  assert.equal(normalizeNoul(q, { probability: 96 }).probability, 0.96);
  assert.equal(normalizeNoul(q, { probability: -1 }).probability, 0);
  assert.equal(normalizeNoul(q, {}).probability, null);
});

test("SubQ wire shapes: type-named noul key and bare number both map", () => {
  const q = { type: "noul", instructions: "x" };
  assert.equal(normalizeNoul(q, { noul: 0.9725 }).probability, 0.9725, "SubQ's {noul: p} shape");
  assert.equal(normalizeNoul(q, 0.5).probability, 0.5, "a bare number");
  assert.equal(normalizeNoul(q, { noul: 97.25 }).probability, 0.9725, "a percent under the type key");
});

test("string state is accepted for prose-state providers; empty string is not", () => {
  assert.equal(validateRequest({ state: "Patient has a fever.", questions: { a: { type: "noul", instructions: "x" } } }), null);
  assert.match(validateRequest({ state: "  ", questions: { a: { type: "noul", instructions: "x" } } }), /state/);
  assert.match(validateRequest({ state: 42, questions: { a: { type: "noul", instructions: "x" } } }), /state/);
});

test("the provider response maps into normalized answers", () => {
  const questions = {
    route: { type: "choice", criteria: { fast: "a", strong: "b" } },
    difficulty: { type: "score", criteria: ["easy", "hard"] },
    verify: { type: "noul", instructions: "needs verification?" }
  };
  const answers = mapSystemOneResponse({
    json: { answers: {
      route: { choice: "strong", probabilities: { fast: 0.1, strong: 0.9 } },
      difficulty: { score: 1 },
      verify: { probability: 0.8 }
    } },
    questions
  });
  assert.equal(answers.route.type, "choice");
  assert.equal(answers.route.choice, "strong");
  assert.equal(answers.difficulty.label, "hard");
  assert.equal(answers.verify.probability, 0.8);
});

test("a bare question-keyed response is accepted too", () => {
  const questions = { ok: { type: "noul", instructions: "x" } };
  const answers = mapSystemOneResponse({ json: { ok: { probability: 0.5 } }, questions });
  assert.equal(answers.ok.probability, 0.5);
});

test("systemone format and path are recognized without naming a vendor", () => {
  assert.equal(isSystemOneFormat("systemone"), true);
  assert.equal(isSystemOneFormat("SystemOne"), true);
  assert.equal(isSystemOneFormat("openai"), false);
  assert.equal(systemOnePath(), "/v1/systemone");
});

test("the auto capability envelope is built only from chat routes", () => {
  // The caller filters decision rows out before calling this; the envelope
  // itself only knows about context/output/tools/vision, so a decision model
  // can never be advertised as a context-bearing answer generator.
  const env = buildCapabilityEnvelope([
    { providerId: 1, context: 128000, output: 8192, tools: true, vision: false, reasoning: true }
  ]);
  assert.equal(env.routing.eligible_routes, 1);
  assert.equal(env.context_window, 128000);
  assert.equal(env.capabilities.streaming, true);
});

async function seededDecisionGateway() {
  const { createApp, __test: gw } = await import("../src/index.js");
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "test-crypto-key-please-change", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind("sk-dec", "d", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(1, "TypeSafe", "https://up.local", "direct", "systemone", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)")
    .bind(1, await gw.sealProviderKey(env, "dec-secret"), "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled, model_kind, wire_format) VALUES (?,?,?,0,1,'decision','systemone')")
    .bind("jev", 1, "jev-latest").run();
  return { app: createApp(env), db, env };
}

const question = { state: { task: "fix auth race" }, questions: { verify: { type: "noul", instructions: "Does this need verification?" } } };

test("/v1/systemone reaches a decision route and returns typed answers", async () => {
  const { app } = await seededDecisionGateway();
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ answers: { verify: { probability: 0.93 } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await app.fetch(new Request("http://gw/v1/systemone", {
      method: "POST",
      headers: { authorization: "Bearer sk-dec", "content-type": "application/json" },
      body: JSON.stringify({ model: "jev", ...question })
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.model, "jev");
    assert.equal(body.answers.verify.probability, 0.93);
    assert.equal(body.source, "remote");
    assert.ok(seen.url.endsWith("/v1/systemone"), "the adapter posts to the systemone path, got " + seen.url);
    assert.equal(seen.body.model, "jev-latest", "the upstream sees the configured upstream model, not the public slug");
  } finally {
    globalThis.fetch = orig;
  }
});

test("a decision model refuses PROSE chat (messages) on the chat endpoint, before any upstream call", async () => {
  const { app } = await seededDecisionGateway();
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response("{}", { status: 200 }); };
  try {
    const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-dec", "content-type": "application/json" },
      body: JSON.stringify({ model: "jev", messages: [{ role: "user", content: "hi" }] })
    }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.type, "model_endpoint_mismatch");
    assert.equal(called, 0, "no upstream call may be made for a decision model on the chat endpoint");
  } finally {
    globalThis.fetch = orig;
  }
});

test("a decision model BRIDGES a SystemOne-shaped chat request and answers in an OpenAI envelope", async () => {
  const { app } = await seededDecisionGateway();
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url) };
    return new Response(JSON.stringify({ answers: { verify: { probability: 0.9 } } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = await app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-dec", "content-type": "application/json" },
      body: JSON.stringify({ model: "jev", state: { task: "fix auth race" }, questions: { verify: { type: "noul", instructions: "Does this need verification?" } } })
    }));
    assert.equal(res.status, 200, "the bridge answers, not a 400 mismatch");
    const body = await res.json();
    assert.equal(body.object, "chat.completion", "a chat-SDK client sees a chat completion");
    assert.ok(Array.isArray(body.choices) && body.choices.length === 1);
    assert.equal(body.choices[0].message.role, "assistant");
    const inner = JSON.parse(body.choices[0].message.content);
    assert.equal(inner.answers.verify.probability, 0.9, "the decision answers ride inside the envelope");
    assert.equal(inner.model, "jev");
    assert.equal(body.answers.verify.probability, 0.9, "the native fields sit alongside the envelope too");
    assert.ok(seen.url.endsWith("/v1/systemone"), "the upstream decision call goes to the systemone path");
  } finally {
    globalThis.fetch = orig;
  }
});

test("the direct /v1/systemone endpoint keeps its native response shape", async () => {
  const { app } = await seededDecisionGateway();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ answers: { verify: { probability: 0.4 } } }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const res = await app.fetch(new Request("http://gw/v1/systemone", {
      method: "POST",
      headers: { authorization: "Bearer sk-dec", "content-type": "application/json" },
      body: JSON.stringify({ model: "jev", ...question })
    }));
    const body = await res.json();
    assert.equal(body.object, undefined, "no chat envelope on the native endpoint");
    assert.equal(body.answers.verify.probability, 0.4);
  } finally {
    globalThis.fetch = orig;
  }
});

test("a chat model is refused by /v1/systemone", async () => {
  const { createApp, __test: gw } = await import("../src/index.js");
  const { createDb } = await import("../../server/db.mjs");
  const { readFileSync } = await import("node:fs");
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, PROVIDER_CRYPTO_KEY: "k", ADMIN_TOKEN: "admin" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO api_keys (key_id, name, active, budget_mode, budget_limit, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind("sk-c", "c", 1, "usd", 1e9, now, now).run();
  db.prepare("INSERT INTO providers (id, name, base_url, transport, fmt, healthy, enabled, key_strategy, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(1, "P", "http://p.local", "direct", "openai", 1, 1, "round_robin", now).run();
  db.prepare("INSERT INTO provider_keys (provider_id, api_key, label, enabled, created_at) VALUES (?,?,?,1,?)").bind(1, await gw.sealProviderKey(env, "s"), "primary", now).run();
  db.prepare("INSERT INTO model_routes (slug, provider_id, upstream_model, rank, enabled) VALUES (?,?,?,0,1)").bind("glm-5.3", 1, "g").run();
  const app = createApp(env);
  const res = await app.fetch(new Request("http://gw/v1/systemone", {
    method: "POST",
    headers: { authorization: "Bearer sk-c", "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", ...question })
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.type, "model_endpoint_mismatch");
});

test("/v1/models advertises a decision model on its own endpoint and never in the chat envelope", async () => {
  const { app } = await seededDecisionGateway();
  const res = await app.fetch(new Request("http://gw/v1/models", { headers: { authorization: "Bearer sk-dec" } }));
  const body = await res.json();
  const jev = body.data.find((m) => m.id === "jev");
  assert.ok(jev, "the decision model is discoverable");
  assert.equal(jev.model_kind, "decision");
  assert.equal(jev.protocol, "systemone");
  assert.equal(jev.endpoint, "/v1/systemone");
  assert.equal(jev.capabilities.choice, true);
  const auto = body.data.find((m) => m.id === "auto");
  assert.equal(auto, undefined, "no chat route exists, so auto must not be advertised");
});
