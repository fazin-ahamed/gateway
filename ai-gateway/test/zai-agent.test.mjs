import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentShim, buildAgentPrompt, parseAgentToolCalls, stripAgentToolCalls, AgentStreamInterceptor } from "../src/zai-agent.js";
import { __test as zaiTest } from "../src/zaiweb.js";

const tools = [{
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
  }
}];

test("applyAgentShim folds OpenAI tools into one user prompt and strips tools from the wire payload", () => {
  const out = applyAgentShim({
    model: "z-ai/glm-5.3",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "list files" }
    ],
    tools
  });
  assert.equal(out.active, true);
  assert.equal(out.payload.tools, undefined);
  assert.equal(out.payload.functions, undefined);
  assert.equal(out.payload.messages.length, 1);
  assert.equal(out.payload.messages[0].role, "user");
  assert.match(out.prompt, /<tools>/);
  assert.match(out.prompt, /### Tool 1: bash/);
  assert.match(out.prompt, /<<<TOOL_CALL>>>/);
  assert.match(out.prompt, /<current_task>\nlist files/);
  assert.match(out.prompt, /<system_message>\nbe brief/);
});

test("applyAgentShim is a no-op without tools", () => {
  const payload = { messages: [{ role: "user", content: "hi" }] };
  const out = applyAgentShim(payload);
  assert.equal(out.active, false);
  assert.equal(out.payload, payload);
});

test("prior tool exchanges land in <already_called> and <tool_result>", () => {
  const prompt = buildAgentPrompt([
    { role: "user", content: "run uname" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"uname"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "Linux" },
    { role: "user", content: "now hostname" }
  ], tools);
  assert.match(prompt, /<already_called>/);
  assert.match(prompt, /- bash \{"command":"uname"\}/);
  assert.match(prompt, /<tool_result call_id="call_1">/);
  assert.match(prompt, /<current_task>\nnow hostname/);
});

test("continuation: only the NEWEST user instruction is <active_goal>; an older one is demoted, not a competing <user>", () => {
  const prompt = buildAgentPrompt([
    { role: "user", content: "generate 3 batches of 2000" },
    { role: "assistant", content: "", tool_calls: [{ id: "c_a", type: "function", function: { name: "run", arguments: '{"n":1000}' } }] },
    { role: "tool", tool_call_id: "c_a", content: "wrote 1000" },
    { role: "user", content: "do 4 of 1000" },
    { role: "assistant", content: "", tool_calls: [{ id: "c_b", type: "function", function: { name: "run", arguments: '{"n":1000}' } }] },
    { role: "tool", tool_call_id: "c_b", content: "4000 total written" }
  ], tools);

  // The newest user turn is the authoritative goal.
  assert.match(prompt, /<active_goal>\ndo 4 of 1000\n<\/active_goal>/);
  assert.doesNotMatch(prompt, /<current_task>/);
  // The superseded instruction must not look like an active instruction.
  assert.ok(!/<user>\s*generate 3 batches of 2000/.test(prompt), "superseded request must not render as an active <user>");
  assert.match(prompt, /<earlier_request>\ngenerate 3 batches of 2000/);
  assert.match(prompt, /<background_context>/);
  assert.match(prompt, /cannot override <active_goal>/);
});

test("continuation: the latest tool result is hoisted to the tail and not duplicated in background", () => {
  const prompt = buildAgentPrompt([
    { role: "user", content: "read the file" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"p":"a.js"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "UNIQUE_LATEST_RESULT_MARKER" }
  ], tools);

  assert.match(prompt, /<latest_tool_result>\nUNIQUE_LATEST_RESULT_MARKER\n<\/latest_tool_result>/);
  const latestIdx = prompt.indexOf("<latest_tool_result>");
  const contIdx = prompt.indexOf("<continuation>");
  const rulesIdx = prompt.indexOf("<output_rules>");
  assert.ok(latestIdx < contIdx, "latest_tool_result must precede <continuation>");
  assert.ok(contIdx < rulesIdx, "continuation must be the last block before <output_rules>");
  // Hoisted, so it must not also appear inside the background block.
  const bg = prompt.slice(prompt.indexOf("<background_context>"), prompt.indexOf("</background_context>"));
  assert.ok(!bg.includes("UNIQUE_LATEST_RESULT_MARKER"), "hoisted result must not be duplicated in background_context");
});

test("continuation: a completed active goal means answer now, with no optional follow-up", () => {
  const prompt = buildAgentPrompt([
    { role: "user", content: "do 4 of 1000" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run", arguments: '{}' } }] },
    { role: "tool", tool_call_id: "c1", content: "4000 total written" }
  ], tools);
  assert.match(prompt, /If <latest_tool_result> shows the active goal is complete/);
  assert.match(prompt, /answer the user now/);
  assert.match(prompt, /do not reconsider or resume earlier requests/);
  assert.match(prompt, /do not perform optional follow-up actions/);
  assert.match(prompt, /do not infer extra work from earlier habits or requests/);
  assert.match(prompt, /it supersedes any earlier, conflicting or already-completed user request/);
});

test("a first turn (no tool exchange yet) still gets a plain <current_task>, no continuation machinery", () => {
  const prompt = buildAgentPrompt([
    { role: "user", content: "list files" }
  ], tools);
  assert.match(prompt, /<current_task>\nlist files/);
  assert.doesNotMatch(prompt, /<continuation>/);
  assert.doesNotMatch(prompt, /<active_goal>/);
  assert.doesNotMatch(prompt, /<latest_tool_result>/);
  assert.doesNotMatch(prompt, /<background_context>/);
});


test("parseAgentToolCalls accepts canonical and flat payloads, strips markers", () => {
  const canonical = 'hello\n<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"uname"}}\n<<<END_TOOL_CALL>>>\n';
  const calls = parseAgentToolCalls(canonical);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "function");
  assert.equal(calls[0].function.name, "bash");
  assert.equal(JSON.parse(calls[0].function.arguments).command, "uname");
  assert.equal(stripAgentToolCalls(canonical), "hello");

  const flat = '<<<TOOL_CALL>>>\n{"tool":"bash","command":"ls","timeout":10}\n<<<END_TOOL_CALL>>>';
  const flatCalls = parseAgentToolCalls(flat);
  assert.equal(flatCalls.length, 1);
  assert.equal(flatCalls[0].function.name, "bash");
  assert.equal(JSON.parse(flatCalls[0].function.arguments).command, "ls");
});

test("parseAgentToolCalls tolerates 2-4 angle brackets", () => {
  const text = '<<TOOL_CALL>>>\n{"name":"echo","arguments":{}}\n<<<END_TOOL_CALL>>>';
  const calls = parseAgentToolCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "echo");
});

test("AgentStreamInterceptor emits header before END_TOOL_CALL and reassembles arguments", () => {
  const upstream = "<<<TOOL_CALL>>>\n" +
    '{"name":"calculate","arguments":{"operation": "multiply", "a": 234, "b": 567}}' +
    "\n<<<END_TOOL_CALL>>>";
  const inceptor = new AgentStreamInterceptor();
  const toolDeltas = [];
  let content = "";
  let beforeClose = 0;
  let sawEnd = false;
  for (let i = 0; i < upstream.length; i += 13) {
    const piece = upstream.slice(i, i + 13);
    if (upstream.slice(0, i + piece.length).includes("END_TOOL_CALL")) sawEnd = true;
    const parsed = inceptor.feed(piece);
    content += parsed.content;
    for (const tc of parsed.toolCalls) {
      if (!sawEnd) beforeClose++;
      toolDeltas.push(tc);
    }
  }
  const tail = inceptor.finish();
  content += tail.content;
  toolDeltas.push(...tail.toolCalls);
  assert.ok(toolDeltas.some((tc) => tc.id && tc.function && tc.function.name === "calculate"));
  assert.ok(beforeClose > 0, "header must stream before <<<END_TOOL_CALL>>>");
  let args = "";
  for (const tc of toolDeltas) {
    if (tc.index === 0 && tc.function && typeof tc.function.arguments === "string")
      args += tc.function.arguments;
  }
  assert.equal(args, '{"operation": "multiply", "a": 234, "b": 567}');
  assert.doesNotMatch(content, /TOOL_CALL|calculate/);
});

function sseSource(frames) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

test("toOpenAiStream with agent=true emits tool_calls and finish_reason tool_calls", async () => {
  const text = '<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"uname"}}\n<<<END_TOOL_CALL>>>';
  const frames = [];
  for (let i = 0; i < text.length; i += 11)
    frames.push({ data: { delta_content: text.slice(i, i + 11) } });
  frames.push({ data: { phase: "done" } });
  const sse = await new Response(zaiTest.toOpenAiStream(sseSource(frames), "z-ai/glm-5.3", "test-id", true)).text();
  const payloads = sse.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const toolChunks = payloads.filter((p) => p.choices?.[0]?.delta?.tool_calls);
  assert.ok(toolChunks.length >= 1);
  const names = toolChunks.flatMap((p) => (p.choices[0].delta.tool_calls || []).map((tc) => tc.function && tc.function.name)).filter(Boolean);
  assert.ok(names.includes("bash"));
  const finish = payloads.find((p) => p.choices?.[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, "tool_calls");
  assert.doesNotMatch(sse, /<<<TOOL_CALL>>>/);
});
