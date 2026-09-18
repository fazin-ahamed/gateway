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
