// The neural judging half, end to end: a stub decision provider answers the
// judge's questions, and the resulting scores land in the taste posteriors
// alongside the symbolic rule verdicts.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createDb } from "../../server/db.mjs";
import { createApp, __test as gw } from "../src/index.js";
import { clearVerdicts, loadTasteReport } from "../src/taste.js";

async function fixture(t, { chatReply, judgeAnswers }) {
  gw.__resetCircuitState();
  gw.__resetRouterHealthCache();
  gw.__setModelsDevCache({});
  clearVerdicts();
  const judgeCalls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v1/systemone") {
        judgeCalls.push(body);
        res.end(JSON.stringify({ answers: judgeAnswers(body.questions) }));
      } else {
        res.end(JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: chatReply }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = "http://127.0.0.1:" + server.address().port + "/v1";
  const db = createDb(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const env = { DB: db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "fixture-crypto" };
  const now = new Date().toISOString();
  db.prepare("INSERT INTO providers (id,name,base_url,transport,fmt,healthy,enabled,key_strategy,created_at) VALUES (1,'p',?,'direct','openai',1,1,'failover',?)").bind(base, now).run();
  db.prepare("INSERT INTO provider_keys (provider_id,api_key,label,enabled,created_at) VALUES (1,?,?,1,?)").bind(await gw.sealProviderKey(env, "k"), "k", now).run();
  db.prepare("INSERT INTO model_routes (slug,provider_id,upstream_model,rank,enabled) VALUES ('m',1,'um',0,1)").run();
  // The decision provider (the judge).
  db.prepare("INSERT INTO providers (id,name,base_url,transport,fmt,healthy,enabled,key_strategy,created_at) VALUES (2,'subq',?,'direct','systemone',1,1,'failover',?)").bind(base, now).run();
  db.prepare("INSERT INTO provider_keys (provider_id,api_key,label,enabled,created_at) VALUES (2,?,?,1,?)").bind(await gw.sealProviderKey(env, "jk"), "jk", now).run();
  db.prepare("INSERT INTO model_routes (slug,provider_id,upstream_model,rank,enabled,model_kind,wire_format) VALUES ('judge',2,'subq-snap',0,1,'decision','systemone')").run();
  db.prepare("INSERT INTO api_keys (key_id,name,budget_mode,budget_limit,allowed_models,created_at,updated_at) VALUES ('sk-c','c','tokens',1000000,'m',?,?)").bind(now, now).run();
  const app = createApp(env);
  return {
    db, judgeCalls,
    call: () => app.fetch(new Request("http://gw/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-c", "content-type": "application/json", "x-gateway-cache": "off" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "give json" }], response_format: { type: "json_object" } })
    }), { waitUntil() {} })
  };
}

test("judge scores reach the posteriors; the judge sees the response, not the prompt", async (t) => {
  const f = await fixture(t, {
    chatReply: "not json",
    judgeAnswers: () => ({
      relevant: { noul: 0.9 },
      instruction_following: { noul: 0.1 },
      tone: { noul: 0.8 }
    })
  });
  const res = await f.call();
  assert.equal(res.status, 200);
  assert.equal(f.judgeCalls.length, 1, "one judge call");
  const jc = f.judgeCalls[0];
  assert.equal(jc.state.response, "not json", "the judge reads the response text");
  assert.equal(jc.state.wants_json, true, "the judge knows structured output was wanted");
  assert.ok(!JSON.stringify(jc.state).includes("give json"), "the prompt text is not sent to the judge");
  assert.ok(jc.questions.relevant && jc.questions.instruction_following && jc.questions.tone, "all three dimensions asked");

  const report = await loadTasteReport(f.db);
  const m = report.find((r) => r.slug === "m");
  assert.ok(m, "posteriors exist for the chat model");
  assert.ok(m.rules.judge_relevant && m.rules.judge_relevant.mean > 0.5, "judge_relevant passes (0.9)");
  assert.ok(m.rules.judge_instruction_following && m.rules.judge_instruction_following.mean < 0.5, "judge_instruction_following fails (0.1)");
  assert.ok(m.rules.judge_tone && m.rules.judge_tone.mean > 0.5, "judge_tone passes (0.8)");
});

test("when the judge provider is down, the response and symbolic taste are unaffected", async (t) => {
  const f = await fixture(t, { chatReply: "not json", judgeAnswers: () => { throw new Error("down"); } });
  // Point the judge at a dead port.
  f.db.prepare("UPDATE providers SET base_url='http://127.0.0.1:1/v1' WHERE id=2").run();
  const res = await f.call();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-gateway-taste"), "0.50", "symbolic verdict still reported");
  const report = await loadTasteReport(f.db);
  const m = report.find((r) => r.slug === "m");
  assert.ok(m.rules.json_valid, "symbolic rule present");
  assert.equal(Object.keys(m.rules).filter((k) => k.startsWith("judge_")).length, 0, "no judge rules when the judge is down");
});

test("the judge can be switched off without touching the symbolic layer", async (t) => {
  const f = await fixture(t, { chatReply: "not json", judgeAnswers: () => ({}) });
  const app2 = createApp({ DB: f.db, ADMIN_TOKEN: "admin", PROVIDER_CRYPTO_KEY: "x" });
  await app2.fetch(new Request("http://gw/admin/taste/judge", {
    method: "POST",
    headers: { authorization: "Bearer admin", "content-type": "application/json" },
    body: JSON.stringify({ enabled: false })
  }));
  const res = await f.call();
  assert.equal(res.status, 200);
  assert.equal(f.judgeCalls.length, 0, "no judge call when disabled");
});
