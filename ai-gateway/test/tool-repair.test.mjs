import test from "node:test";
import assert from "node:assert/strict";
import {
  applyToolRepairPolicyToPayload,
  buildToolRepairPolicy,
  canonicalToolName,
  classifyToolResult,
  inspectToolSurface,
  repairToolCall
} from "../src/tool-repair.js";
import { AgentStreamInterceptor, buildAgentPrompt, parseAgentToolCalls } from "../src/zai-agent.js";
import { guardOpenAiSse, repairEditToolArguments } from "../../server/tool-loop-guard.mjs";

const hashTools = [
  {
    type: "function",
    function: {
      name: "hashline_read",
      description: "Read file lines with content hash anchors",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          startLine: { type: "integer" },
          endLine: { type: "integer" }
        },
        required: ["filePath"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "hashline_edit",
      description: "Edit existing files using verified line hashes",
      parameters: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          lineHashes: { type: "string" },
          content: { type: "string" },
          insertAfter: { type: "boolean" }
        },
        required: ["filePath", "lineHashes", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Ordinary text edit",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }
      }
    }
  }
];

test("detects a real hashline surface instead of guessing from generic edit", () => {
  const surface = inspectToolSurface(hashTools);
  assert.equal(surface.hashRead.name, "hashline_read");
  assert.equal(surface.hashEdit.name, "hashline_edit");
  assert.equal(canonicalToolName("HashlineEdit", hashTools), "hashline_edit");
});

test("schema repair canonicalizes tool and argument aliases", () => {
  const repaired = repairToolCall({
    id: "call_x",
    type: "function",
    function: {
      name: "HashlineEdit",
      arguments: JSON.stringify({
        path: "src/app.js",
        line_hashes: "12:a3,13:b4",
        text: "const x = 2;",
        junk: "drop-me"
      })
    }
  }, hashTools);
  assert.equal(repaired.function.name, "hashline_edit");
  assert.deepEqual(JSON.parse(repaired.function.arguments), {
    filePath: "src/app.js",
    lineHashes: "12:a3,13:b4",
    content: "const x = 2;"
  });
});

test("policy is response-adaptive: stale anchors force reread and re-anchor", () => {
  const messages = [
    { role: "user", content: "change src/app.js" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_edit",
        type: "function",
        function: {
          name: "hashline_edit",
          arguments: '{"filePath":"src/app.js","lineHashes":"12:a3","content":"x"}'
        }
      }]
    },
    { role: "tool", tool_call_id: "call_edit", content: "stale read: hash mismatch; file changed" }
  ];
  const policy = buildToolRepairPolicy(messages, hashTools);
  assert.match(policy, /MOST RECENT read result/);
  assert.match(policy, /Never invent hashes/);
  assert.match(policy, /Re-read the affected region with hashline_read/);
  assert.equal(classifyToolResult(messages[2].content), "stale_anchor");
});

test("global policy is injected only when useful and does not fabricate hashline", () => {
  const payload = applyToolRepairPolicyToPayload({
    messages: [{ role: "user", content: "edit a.js" }],
    tools: hashTools
  });
  assert.equal(payload.messages[0].role, "system");
  assert.match(payload.messages[0].content, /mode="hashline"/);

  const generic = applyToolRepairPolicyToPayload({
    messages: [{ role: "user", content: "edit a.js" }],
    tools: [hashTools[2]]
  });
  assert.match(generic.messages[0].content, /mode="native"/);
  assert.match(generic.messages[0].content, /do NOT fabricate hash anchors/);
});

test("ZAI prompt regenerates repair policy without duplicating global wrapper", () => {
  const payload = applyToolRepairPolicyToPayload({
    messages: [{ role: "user", content: "edit a.js" }],
    tools: hashTools
  });
  const prompt = buildAgentPrompt(payload.messages, hashTools);
  assert.match(prompt, /<tool_repair_policy mode="hashline">/);
  assert.doesNotMatch(prompt, /<gateway_tool_repair>/);
});

test("preserves main's bare hashline patch shorthand and compatibility helper", () => {
  const bare = "[src/a.js#4:ab]\\nPUT 4.=4:new";
  const normalized = bare.replace(/\\n/g, "\n");
  assert.deepEqual(JSON.parse(repairEditToolArguments("edit", bare)), { input: normalized });

  const schemaTool = [{
    type: "function",
    function: {
      name: "edit",
      description: "Apply a hashline patch",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false
      }
    }
  }];
  assert.deepEqual(JSON.parse(repairEditToolArguments("edit", bare, schemaTool)), { input: normalized });
});

test("ordinary edit-style stream can carry bare hashline shorthand safely", async () => {
  const tools = [{
    type: "function",
    function: {
      name: "edit",
      description: "Apply edits",
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false
      }
    }
  }];
  const bare = "[src/a.js#4:ab]\\nPUT 4.=4:new";
  const normalized = bare.replace(/\\n/g, "\n");
  const frames = [
    {
      id: "x", model: "m", choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "edit", arguments: bare.slice(0, 12) } }]
      }, finish_reason: null }]
    },
    {
      id: "x", model: "m", choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: bare.slice(12) } }]
      }, finish_reason: null }]
    },
    { id: "x", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ];
  const text = await new Response(guardOpenAiSse(sse(frames), "m", tools)).text();
  const objs = text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const calls = objs.flatMap((o) => o.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "edit");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { input: normalized });
});

test("non-stream ZAI agent call repairs hashline aliases", () => {
  const text = '<<<TOOL_CALL>>>\n{"name":"HashlineEdit","arguments":{"path":"src/a.js","line_hashes":"4:ab","text":"new"}}\n<<<END_TOOL_CALL>>>';
  const calls = parseAgentToolCalls(text, hashTools);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "hashline_edit");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    filePath: "src/a.js",
    lineHashes: "4:ab",
    content: "new"
  });
});

test("ZAI streaming buffers safety-sensitive hashline edit until complete", () => {
  const upstream = '<<<TOOL_CALL>>>\n{"name":"HashlineEdit","arguments":{"path":"src/a.js","line_hashes":"4:ab","text":"new"}}\n<<<END_TOOL_CALL>>>';
  const inceptor = new AgentStreamInterceptor(hashTools);
  const all = [];
  let emittedEarly = false;
  for (let i = 0; i < upstream.length; i += 9) {
    const part = upstream.slice(i, i + 9);
    const parsed = inceptor.feed(part);
    if (!upstream.slice(0, i + part.length).includes("END_TOOL_CALL") && parsed.toolCalls.length) emittedEarly = true;
    all.push(...parsed.toolCalls);
  }
  all.push(...inceptor.finish().toolCalls);
  assert.equal(emittedEarly, false);
  assert.equal(all.length, 1);
  assert.equal(all[0].function.name, "hashline_edit");
  assert.equal(JSON.parse(all[0].function.arguments).lineHashes, "4:ab");
});

function sse(frames) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode("data: " + JSON.stringify(frame) + "\n\n"));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

test("direct OpenAI stream buffers partial hashline JSON and emits one repaired call", async () => {
  const frames = [
    {
      id: "x", model: "m", choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "HashlineEdit", arguments: '{"path":"src/a.js",' } }]
      }, finish_reason: null }]
    },
    {
      id: "x", model: "m", choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, function: { arguments: '"line_hashes":"4:ab","text":"new"}' } }]
      }, finish_reason: null }]
    },
    { id: "x", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
  ];
  const text = await new Response(guardOpenAiSse(sse(frames), "m", hashTools)).text();
  const objs = text.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
  const calls = objs.flatMap((o) => o.choices?.[0]?.delta?.tool_calls || []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "hashline_edit");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), {
    filePath: "src/a.js",
    lineHashes: "4:ab",
    content: "new"
  });
  const finish = objs.find((o) => o.choices?.[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, "tool_calls");
});
