// Z.ai consumer chat (chat.z.ai) provider adapter.
//
// An OpenAI-compatible front for Z.ai's web chat. Session state (cookies,
// guest/account token, frontend version) lives in the Node-native
// ZaiSession, so the signed path no longer depends on a hand-pasted JWT and
// a browser-issued CAPTCHA proof is the only per-request input.
//
// Wire shape ported from OmniRoute (open-sse/executors/zai-web) so both
// gateways speak the identical protocol.

import { sessionFor } from "./zai-session.js";
import { registryFor } from "./zai-models.js";
import { createZaiFrameNormalizer } from "./zai-stream.js";
import { isZaiWafBlock, zaiWaf, ZaiWafBlockedError } from "./zai-waf.js";
import { applyAgentShim, parseAgentToolCalls, stripAgentToolCalls, AgentStreamInterceptor } from "./zai-agent.js";
import { acquireZaiChatId, releaseZaiChatId } from "./zai-session-pool.js";
import { getZaiCaptchaProof } from "./zai-captcha-cache.js";
import { attachZaiImageParts, processZaiVisionMessages } from "./zai-vision.js";

const ZAI_BASE_URL = "https://chat.z.ai";
const ZAI_NEW_CHAT_URL = ZAI_BASE_URL + "/api/v1/chats/new";
const ZAI_CHAT_URL = ZAI_BASE_URL + "/api/v2/chat/completions";
const ZAI_SETTINGS_URL = ZAI_BASE_URL + "/api/v1/users/user/settings";
const ZAI_DELETE_CHAT_URL = (chatId) => ZAI_BASE_URL + "/api/v1/chats/" + encodeURIComponent(chatId);
const ZAI_DEFAULT_MODEL = "glm-5.3";
const ZAI_DEFAULT_FE_VERSION = "prod-fe-1.1.93";
const ZAI_FE_VERSION_CACHE_MS = 15 * 60 * 1000;
const ZAI_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
const CLIENT_PROTOCOL_VERSION = "0.0.1";
const SIGNATURE_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%";

// chat.z.ai exposes no token accounting on the stream, so usage is estimated
// for the gateway's own counters: ~4 chars/token on the prompt, ~3 chars per
// output token (denser than prose because of code and markup), plus a fixed
// per-image allowance. Order-of-magnitude only — never billed.
const PROMPT_CHARS_PER_TOKEN = 4;
const OUTPUT_CHARS_PER_TOKEN = 3;
const IMAGE_TOKEN_ALLOWANCE = 500;

// Descriptions of what each consumer model accepts. `vision` gates image
// input. `context` is the measured chat.z.ai transport window (not the
// theoretical 1M GLM-5.3 paper context). `output` is the completion clamp.
const ZAI_MODELS = {
  // GLM-Free-API's proven web flow uploads image bytes to /api/v1/files/
  // and attaches the returned file objects. The flash route is therefore
  // genuinely multimodal now instead of forwarding image URLs as text.
  "glm-5.3-flash": { name: "GLM-5.3-Flash", thinking: true, vision: true, context: 98304, output: 16384 },
  "glm-5.3": { name: "GLM-5.3", thinking: true, vision: false, context: 98304, output: 16384 },
  "glm-5.2": { name: "GLM-5.2", thinking: true, vision: false, context: 98304, output: 16384 }
};

function unprefixedModelId(modelId) {
  return String(modelId || "").trim().split("/").pop() || String(modelId || "").trim();
}

function capabilityModelId(modelId) {
  const id = unprefixedModelId(modelId).toLowerCase();
  return id === "x-preview-l" ? "glm-5.3-flash" : id;
}

// Public slug → the opaque id chat.z.ai expects on the wire.
function upstreamModelId(modelId) {
  const id = unprefixedModelId(modelId);
  return id.toLowerCase() === "glm-5.3-flash" ? "x-preview-l" : id;
}

function getModelCapabilities(modelId) {
  return ZAI_MODELS[capabilityModelId(modelId)] || null;
}

// Shape a catalog row like the models.dev entries the auto-router consumes:
// the gateway's router gates on context/vision/tools without a special case.
export function modelCatalogEntry(modelId) {
  const id = capabilityModelId(modelId);
  const caps = ZAI_MODELS[id];
  if (!caps)
    return null;
  return {
    id: "zai-web/" + id,
    reasoning: caps.thinking,
    // Caller tools are supported through the gateway's agent shim + repair
    // layer even though chat.z.ai itself does not expose native OpenAI tools.
    toolCall: true,
    attachment: caps.vision,
    modalities: { input: caps.vision ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: caps.context, output: caps.output }
  };
}

function isZaiModel(slug) {
  return !!getModelCapabilities(slug);
}

// A token may arrive as the bare JWT, a `Bearer …` header value, a cookie
// blob containing `token=…`, or the JSON the site keeps in localStorage.
function extractToken(raw) {
  const trimmed = String(raw == null ? "" : raw).trim();
  if (!trimmed)
    return "";
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed);
      const token = json && (json.token || json.accessToken || json.access_token);
      if (typeof token === "string")
        return token.trim();
    } catch {
      return "";
    }
    return "";
  }
  const bearer = trimmed.match(/^(?:Authorization:\s*)?Bearer\s+(.+)$/i);
  if (bearer)
    return bearer[1].trim();
  const cookie = trimmed.match(/(?:^|;\s*)token=([^;]+)/);
  if (cookie)
    return cookie[1].trim();
  // A bare JWT (three dot-separated segments) is the common paste.
  return trimmed.includes("=") || trimmed.includes(";") ? "" : trimmed;
}

function captureVerifyParam(value) {
  if (value && typeof value === "object") {
    const direct = value.captcha_verify_param || value.captchaVerifyParam;
    if (typeof direct === "string" && direct.trim())
      return direct.trim();
    if (value.providerSpecificData)
      return captureVerifyParam(value.providerSpecificData);
    return "";
  }
  if (typeof value !== "string")
    return "";
  const inline = value.match(/(?:^|;\s*)captcha_verify_param=([^;]+)/);
  if (inline)
    return inline[1].trim();
  if (value.trim().startsWith("{")) {
    try {
      return captureVerifyParam(JSON.parse(value));
    } catch {
      return "";
    }
  }
  return "";
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return hex(new Uint8Array(sig));
}

// The site's request signature: an HMAC keyed by a 5-minute time bucket, over
// the sorted client params plus the base64 prompt.
async function buildSignature(input) {
  const timestamp = String(input.timestamp);
  const sortedPayload = [["timestamp", timestamp], ["requestId", input.requestId], ["user_id", input.userId]]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((pair) => pair.join(","))
    .join(",");
  const encodedPrompt = bytesToBase64(new TextEncoder().encode(String(input.prompt || "").trim()));
  const bucket = Math.floor(Number(timestamp) / (5 * 60 * 1000));
  const derivedKey = await hmacSha256(SIGNATURE_KEY, String(bucket));
  return hmacSha256(derivedKey, sortedPayload + "|" + encodedPrompt + "|" + timestamp);
}

// The site hands back a refreshed session token as a cookie on chat creation;
// picking it up keeps a long-lived route alive without a manual re-paste.
function rotatedToken(headers) {
  if (!headers || typeof headers.get !== "function")
    return "";
  const cookie = headers.get("set-cookie");
  if (!cookie)
    return "";
  const match = cookie.match(/(?:^|[;\s])token=([^;,\s]+)/);
  if (!match)
    return "";
  const value = extractToken(match[1]);
  return value && value.split(".").length === 3 ? value : "";
}

function userIdFromToken(token) {
  const payload = String(token).split(".")[1];
  if (!payload)
    return "";
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    return typeof decoded.id === "string" ? decoded.id : "";
  } catch {
    return "";
  }
}

function browserPoolIdForToken(token) {
  const userId = userIdFromToken(token);
  return userId ? "uid:" + userId : "";
}

function textContent(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object")
      continue;
    if (part.type === "text" || part.type === "input_text") {
      const text = part.text ?? part.content;
      if (typeof text === "string")
        parts.push(text);
      continue;
    }
    // Before the vision upload pass this preserves image references for
    // prompt accounting/fallback text. The pure-HTTP vision path later
    // rewrites image_url values to real uploaded Z.AI file ids.
    if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string")
      parts.push("[image: " + part.image_url.url.slice(0, 2048) + "]");
  }
  return parts.join("\n");
}

function latestUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i] && messages[i].role === "user")
      return textContent(messages[i].content);
  return "";
}

// GLM-Free-API signs the concatenation of all message text, not only the
// newest user turn. This matters because signature_prompt must match the
// exact conversation payload the completion carries.
function referencePrompt(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => textContent(m && m.content))
    .filter((x) => x !== "")
    .join("\n\n")
    .trim();
}

// chat.z.ai only accepts role=user. When the caller sent OpenAI tools, fold
// the whole conversation + tool contract into one user prompt and parse
// <<<TOOL_CALL>>> blocks on the way out. Never forward raw `tools`.
function prepareZaiTurn(payload) {
  const shim = applyAgentShim(payload);
  const messages = Array.isArray(shim.payload.messages) ? shim.payload.messages : [];
  const prompt = shim.active ? shim.prompt : referencePrompt(messages);
  return { shim, messages, prompt };
}

function foldMessages(messages) {
  return (messages || []).map((m) => ({ role: m && m.role || "user", content: textContent(m && m.content) }));
}

function countImages(messages) {
  let count = 0;
  for (const m of messages || []) {
    if (!m || m.role !== "user" || !Array.isArray(m.content))
      continue;
    for (const part of m.content)
      if (part && part.type === "image_url")
        count++;
  }
  return count;
}

function estimatePromptTokens(messages, toolsChars) {
  let chars = Number(toolsChars) || 0;
  for (const m of messages || []) {
    const content = m && m.content;
    if (typeof content === "string")
      chars += content.length;
    else if (Array.isArray(content))
      chars += textContent(content).length;
  }
  return Math.ceil(chars / PROMPT_CHARS_PER_TOKEN);
}

// The consumer settings UI exposes a bucketed effort selector. Live model
// data only advertises buckets the account actually has; sending an
// unsupported value can corrupt the response. Keep to high/max for now;
// more granular levels require live capability discovery.
function resolveThinking(modelId, payload, liveEntry = null) {
  const caps = getModelCapabilities(modelId);
  const supportsThinking = liveEntry ? liveEntry.reasoning !== false : !!(caps && caps.thinking);
  if (!supportsThinking)
    return { enabled: false, effort: "high", effortSupported: false };

  const reasoning = payload && payload.reasoning;
  const thinking = payload && payload.thinking;
  if (reasoning === false || thinking && thinking.type === "disabled")
    return { enabled: false, effort: "high", effortSupported: true };

  const raw = typeof payload?.reasoning_effort === "string"
    ? payload.reasoning_effort.trim().toLowerCase()
    : typeof reasoning?.effort === "string"
      ? reasoning.effort.trim().toLowerCase()
      : "";
  const effort = raw === "max" || raw === "xhigh" ? "max" : "high";
  return { enabled: true, effort, effortSupported: true };
}

// Web search / tools switches shown in the site UI. Defaults off: the gateway
// never silently upgrades a request into a search or agent turn.
function resolveFeatures(payload, agentMode = false) {
  const opt = (key) => payload && (payload[key] !== undefined ? payload[key] : payload.features?.[key]);
  const webSearch = opt("web_search") ?? opt("auto_web_search") ?? opt("webSearch") ?? opt("search");
  const advancedSearch = opt("advancedSearch") ?? opt("advanced_search");
  // Z.AI's own search/MCP tools and caller-provided agent tools share the
  // model's action channel; the reference disables internal search in agent
  // mode to prevent marker/tool conflicts.
  if (agentMode)
    return { toolsEnabled: false, webSearchEnabled: false, advancedSearchEnabled: false };
  return {
    toolsEnabled: opt("vlm_tools_enable") === true,
    webSearchEnabled: webSearch === true || advancedSearch === true,
    advancedSearchEnabled: advancedSearch === true
  };
}

function buildHeaders(token, options) {
  const headers = {
    "Content-Type": "application/json",
    Accept: options.accept,
    "Accept-Language": "en-US",
    "User-Agent": ZAI_USER_AGENT,
    Origin: ZAI_BASE_URL,
    Referer: ZAI_BASE_URL + "/",
    Authorization: "Bearer " + token
  };
  if (options.frontendVersion)
    headers["X-FE-Version"] = options.frontendVersion;
  if (options.signature)
    headers["X-Signature"] = options.signature;
  if (options.region !== false)
    headers["X-Region"] = "overseas";
  return headers;
}

// The completion URL carries the client telemetry chat.z.ai expects. Static
// screen/timezone values are intentional: they are part of the signed shape.
function buildCompletionUrl(input) {
  const now = new Date(input.timestamp);
  const params = new URLSearchParams({
    timestamp: String(input.timestamp),
    requestId: input.requestId,
    user_id: input.userId,
    version: CLIENT_PROTOCOL_VERSION,
    platform: "web",
    token: input.token,
    user_agent: ZAI_USER_AGENT,
    language: "en-US",
    languages: "en-US,en",
    timezone: "UTC",
    cookie_enabled: "true",
    screen_width: "1280",
    screen_height: "800",
    screen_resolution: "1280x800",
    viewport_height: "800",
    viewport_width: "1280",
    viewport_size: "1280x800",
    color_depth: "24",
    pixel_ratio: "1",
    current_url: ZAI_BASE_URL + "/",
    pathname: "/",
    search: "",
    hash: "",
    host: "chat.z.ai",
    hostname: "chat.z.ai",
    protocol: "https:",
    referrer: "",
    title: "Z.ai - Advanced AI Chatbot & Agent powered by GLM-5.3",
    timezone_offset: "0",
    local_time: now.toISOString(),
    utc_time: now.toUTCString(),
    is_mobile: "false",
    is_touch: "false",
    max_touch_points: "0",
    browser_name: "Chrome",
    os_name: "Mac OS",
    signature_timestamp: String(input.timestamp)
  });
  return ZAI_CHAT_URL + "?" + params.toString();
}

// Reference pure-HTTP wire shape from GLM-Free-API. Keep this separate from
// the browser's opaque x-preview-l model selector and from the legacy chat
// creation payload: the proven HTTP completion uses the public model id,
// a client-generated chat UUID, and a deliberately minimal body.
function referenceHttpModelId(modelId) {
  const id = unprefixedModelId(modelId);
  return id.toLowerCase() === "x-preview-l" ? "glm-5.3-flash" : id;
}

function buildReferenceCompletionUrl(input) {
  const params = new URLSearchParams({
    timestamp: String(input.timestamp),
    requestId: input.requestId,
    user_id: input.userId,
    version: CLIENT_PROTOCOL_VERSION,
    platform: "web",
    token: input.token,
    user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
    language: "en-US",
    screen_resolution: "1920x1080",
    viewport_size: "1920x1080",
    timezone: "Europe/Paris",
    timezone_offset: "-60",
    signature_timestamp: String(input.timestamp)
  });
  return ZAI_CHAT_URL + "?" + params.toString();
}

function buildReferenceFeatures({ thinking, features }) {
  const out = {
    enable_thinking: !!thinking.enabled,
    flags: [],
    image_generation: false,
    web_search: false
  };
  if (features.webSearchEnabled)
    out.auto_web_search = true;
  if (thinking.enabled && thinking.effortSupported)
    out.reasoning_effort = thinking.effort;
  return out;
}

function buildReferenceCompletionBody(input) {
  const body = {
    model: referenceHttpModelId(input.modelId),
    chat_id: input.chatId,
    messages: input.messages,
    signature_prompt: input.prompt,
    stream: true,
    captcha_verify_param: input.captchaVerifyParam,
    features: buildReferenceFeatures({ thinking: input.thinking, features: input.features })
  };
  if (input.files && input.files.length)
    body.files = input.files;
  if (input.features.advancedSearchEnabled)
    body.mcp_servers = ["advanced-search"];
  return body;
}

function buildNewChatBody(input) {
  const { userMessageId } = input;
  const model = upstreamModelId(input.modelId);
  const body = {
    chat: {
      id: "",
      title: "New Chat",
      models: [model],
      params: {},
      history: { messages: { [userMessageId]: { id: userMessageId, parentId: null, childrenIds: [], role: "user", content: input.prompt, timestamp: Math.floor(Date.now() / 1000), models: [model] } }, currentId: userMessageId },
      tags: [],
      flags: [],
      // chat.z.ai accepts features:[] for both guest and signed-in accounts; the
      // tool-selector placeholder the web client sends is rejected on stricter
      // accounts and surfaced as an upstream outage, so omit it.
      features: [],
      mcp_servers: [],
      enable_thinking: input.enableThinking,
      reasoning_effort: input.reasoningEffort,
      auto_web_search: input.features.webSearchEnabled,
      message_version: 1,
      extra: { vlm_tools_enable: input.features.toolsEnabled, vlm_web_search_enable: false, vlm_website_mode: false },
      timestamp: Date.now(),
      type: "default"
    }
  };
  return { userMessageId, payload: { chat: body.chat } };
}

function buildCompletionBody(input) {
  const params = {};
  for (const key of ["temperature", "top_p", "max_tokens", "stop"])
    if (input.body && input.body[key] !== undefined)
      params[key] = input.body[key];
  const caps = getModelCapabilities(input.modelId);
  if (params.max_tokens !== undefined && caps)
    params.max_tokens = Math.min(Number(params.max_tokens) || 0, caps.output);
  const features = {
    image_generation: false,
    web_search: false,
    auto_web_search: input.features.webSearchEnabled,
    preview_mode: true,
    flags: [],
    vlm_tools_enable: input.features.toolsEnabled,
    vlm_web_search_enable: false,
    vlm_website_mode: false,
    enable_thinking: input.enableThinking
  };
  if (input.enableThinking && input.effortSupported)
    features.reasoning_effort = input.reasoningEffort;
  return {
    stream: true,
    model: upstreamModelId(input.modelId),
    messages: foldMessages(input.messages),
    signature_prompt: input.prompt,
    params,
    extra: { vlm_tools_enable: input.features.toolsEnabled, vlm_web_search_enable: false, vlm_website_mode: false },
    features,
    variables: {},
    chat_id: input.chatId,
    id: input.requestId,
    current_user_message_id: input.userMessageId,
    current_user_message_parent_id: null,
    background_tasks: { title_generation: true, tags_generation: true },
    captcha_verify_param: input.captchaVerifyParam
  };
}

// chat.z.ai streams SSE in the same frames whether or not the client asked
// for streaming. The normalizer maintains the authoritative snapshot so
// edit_content rewrites never get mistaken for append-only deltas.
async function readDeltas(source, onDelta, options = {}) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const normalizer = createZaiFrameNormalizer(options);
  let buffer = "";
  let stopped = false;
  const emit = (events) => {
    for (const event of events) {
      if (onDelta(event)) {
        stopped = true;
        return true;
      }
    }
    return false;
  };
  try {
    for (; !stopped ;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          emit(normalizer.finish());
          stopped = true;
          break;
        }
        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue;
        }
        if (emit(normalizer.push(frame))) break;
      }
    }
    if (!stopped)
      emit(normalizer.finish());
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function chunk(id, created, model, delta, finish, usage) {
  const out = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] };
  if (usage)
    out.usage = usage;
  return out;
}

// Convert the upstream frame stream into an OpenAI SSE stream. Emits at most
// one finish chunk, and never a contentless frame (strict clients index
// choices[0] and choke on `choices: []`). When agent=true, <<<TOOL_CALL>>>
// blocks become incremental tool_calls deltas and finish_reason=tool_calls.
function toOpenAiStream(source, model, id, agent = false, tools = []) {
  const created = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  let started = false;
  let finished = false;
  let chars = 0;
  let sawToolCalls = false;
  const interceptor = agent ? new AgentStreamInterceptor(tools) : null;
  return new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
      const emitToolCalls = (toolCalls) => {
        if (!toolCalls || !toolCalls.length) return;
        if (!started) {
          started = true;
          send(chunk(id, created, model, { role: "assistant" }));
        }
        sawToolCalls = true;
        send(chunk(id, created, model, { tool_calls: toolCalls }));
      };
      const finish = (reason) => {
        if (finished)
          return;
        finished = true;
        if (interceptor) {
          const tail = interceptor.finish();
          if (tail.content) {
            chars += tail.content.length;
            if (!started) {
              started = true;
              send(chunk(id, created, model, { role: "assistant" }));
            }
            send(chunk(id, created, model, { content: tail.content }));
          }
          emitToolCalls(tail.toolCalls);
        }
        const usage = { prompt_tokens: 0, completion_tokens: Math.ceil(chars / OUTPUT_CHARS_PER_TOKEN), total_tokens: Math.ceil(chars / OUTPUT_CHARS_PER_TOKEN), cost_usd: 0 };
        send(chunk(id, created, model, {}, reason || (sawToolCalls ? "tool_calls" : "stop"), usage));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
      };
      try {
        await readDeltas(source, (delta) => {
          if (delta.error) {
            finished = true;
            send({ error: { message: "Upstream stream failed", type: "upstream_stream_error", code: "upstream_stream_error", retryable: true } });
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            return true;
          }
          if (delta.reasoning) {
            if (!started) {
              started = true;
              send(chunk(id, created, model, { role: "assistant" }));
            }
            send(chunk(id, created, model, { reasoning_content: delta.reasoning }));
          }
          if (delta.content) {
            if (interceptor) {
              const parsed = interceptor.feed(delta.content);
              if (parsed.content) {
                chars += parsed.content.length;
                if (!started) {
                  started = true;
                  send(chunk(id, created, model, { role: "assistant" }));
                }
                send(chunk(id, created, model, { content: parsed.content }));
              }
              emitToolCalls(parsed.toolCalls);
            } else {
              if (!started) {
                started = true;
                send(chunk(id, created, model, { role: "assistant" }));
              }
              chars += delta.content.length;
              send(chunk(id, created, model, { content: delta.content }));
            }
          }
          if (delta.done) {
            finish();
            return true;
          }
          return false;
        });
        if (!finished) {
          if (!started)
            send(chunk(id, created, model, { role: "assistant" }));
          finish();
        }
        controller.close();
      } catch (e) {
        try {
          send({ error: { message: "Upstream stream disconnected", type: "upstream_stream_error", code: "upstream_socket_closed", retryable: true } });
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
        }
      }
    }
  });
}

// --- transport -------------------------------------------------------------

let feVersionCache = { value: "", at: 0 };

async function resolveFrontendVersion(fetcher) {
  const now = Date.now();
  if (feVersionCache.value && now - feVersionCache.at < ZAI_FE_VERSION_CACHE_MS)
    return feVersionCache.value;
  let version = ZAI_DEFAULT_FE_VERSION;
  try {
    const res = await fetcher(ZAI_BASE_URL + "/", { headers: { Accept: "text/html", "User-Agent": ZAI_USER_AGENT } });
    if (res.ok) {
      const match = (await res.text()).match(/\/frontend\/(prod-fe-\d+(?:\.\d+)*)\/assets\//);
      if (match)
        version = match[1];
    }
  } catch {
  }
  feVersionCache = { value: version, at: now };
  return version;
}

export class ZaiWebError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "ZaiWebError";
    this.status = status;
    this.code = code || "zai_error";
    this.retryAfterSec = 0;
  }
}

function asWafError(err) {
  if (!(err instanceof ZaiWafBlockedError)) return err;
  const out = new ZaiWebError(503, "The Z.AI edge is temporarily blocked for this gateway egress. Retry later.", "zai_waf");
  out.retryAfterSec = err.retryAfterSec;
  return out;
}

async function awaitWafSlot() {
  try {
    await zaiWaf.beforeRequest();
  } catch (err) {
    throw asWafError(err);
  }
}

function assertWafAvailable() {
  try {
    zaiWaf.assertAvailable();
  } catch (err) {
    throw asWafError(err);
  }
}

function credentialError() {
  return new ZaiWebError(503, "Z.ai session has no usable user id: guest bootstrap failed and no account token was supplied in the provider key.", "zai_credentials");
}

// chat.z.ai issues the captcha proof per completion, so it cannot be stored
// with the credential and reused. A caller holding a fresh one can pass it per
// request instead of re-pasting the provider key.
var ZAI_CAPTCHA_HEADERS = ["x-zai-captcha", "x-zai-captcha-verify-param", "x-captcha-verify-param"];
export function captureFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function")
    return "";
  for (const name of ZAI_CAPTCHA_HEADERS) {
    const value = headers.get(name);
    if (value && String(value).trim())
      return String(value).trim();
  }
  return "";
}

// Credential bag accepted as the provider key: a JSON object with `token`
// and `captcha_verify_param`, or a raw JWT / cookie string.
function parseCredential(rawKey, payload, headers) {
  let token = "";
  let captcha = "";
  const key = String(rawKey == null ? "" : rawKey);
  if (key.trim().startsWith("{")) {
    try {
      const json = JSON.parse(key);
      token = extractToken(JSON.stringify(json));
      captcha = captureVerifyParam(json);
    } catch {
      token = extractToken(key);
    }
  } else {
    token = extractToken(key);
  }
  // Precedence: a per-request header (newest proof) beats the stored one, then
  // anything the caller inlined in the request body.
  if (!captcha)
    captcha = captureVerifyParam(payload);
  const fromHeader = captureFromHeaders(headers);
  if (fromHeader)
    captcha = fromHeader;
  return { token, captcha };
}

// chat.z.ai/Aliyun fingerprints the TLS client hello, which Node's fetch
// cannot imitate. When ZAI_UTLS_PROXY points at the local zaihttp helper, the
// chat.z.ai calls are routed through it so they carry a Chrome ClientHello.
// Everything else (and every test) keeps using the plain fetcher.
export function wrapUtlsFetcher(fetcher) {
  const proxy = process.env.ZAI_UTLS_PROXY;
  if (!proxy || typeof fetcher !== "function")
    return fetcher;
  const base = String(proxy).replace(/\/+$/, "");
  return async (url, init = {}) => {
    let host = "";
    try {
      host = new URL(String(url)).hostname;
    } catch {
      return fetcher(url, init);
    }
    if (host !== "chat.z.ai")
      return fetcher(url, init);
    return fetcher(base + "/proxy", {
      ...init,
      method: "POST",
      headers: {
        ...(init.headers || {}),
        "X-Target-Url": String(url),
        "X-Target-Method": String(init.method || "GET").toUpperCase()
      }
    });
  };
}
// Pure-HTTP Z.AI engine, based on GLM-Free-API's proven serving flow.
//
// Crucial invariants:
// - chat ids are client-generated UUIDs; no /api/v1/chats/new round-trip;
// - CAPTCHA is minted immediately before the one completion POST;
// - the HTTP wire uses the public model id (glm-5.3-flash), not the browser
//   selector alias x-preview-l;
// - request body stays minimal and matches the official web completion shape;
// - every referenced chat is deleted after the response drains.
async function runReferenceZaiHttp(c, route, rawKey, payload, isStream, options = {}) {
  const baseFetcher = options.fetchImpl || (c && c.upstreamFetch) || globalThis.fetch;
  const fetcher = wrapUtlsFetcher(baseFetcher);
  const modelId = route.upstream_model || payload.model || ZAI_DEFAULT_MODEL;
  const staticCaps = getModelCapabilities(modelId);

  const headerView = c && c.req && typeof c.req.header === "function"
    ? { get: (name) => c.req.header(name) }
    : null;
  const parsed = parseCredential(rawKey, payload, headerView);
  const credentialToken = parsed.token;

  const session = sessionFor({ fetcher, credential: credentialToken, key: route.zai_session_key });
  const registry = registryFor({ session, fetcher, fallback: (id) => modelCatalogEntry(id) });
  const entry = await registry.resolve(modelId);
  if (!entry && !staticCaps)
    throw new ZaiWebError(503, 'Z.ai consumer model "' + unprefixedModelId(modelId) + '" is not available in the live model catalog.', "zai_model");
  if (entry && entry.available === false)
    throw new ZaiWebError(503, 'Z.ai model "' + unprefixedModelId(modelId) + '" is not available for this account.', "zai_model_unavailable");

  // Reference flow rejects early during an IP/WAF block, before image uploads
  // and before burning a single-use device token.
  assertWafAvailable();

  const active = await session.acquire();
  let token = active.token;
  let userId = active.userId || userIdFromToken(token);
  if (!token || !userId)
    throw credentialError();
  if (!session.feVersion)
    session.feVersion = await resolveFrontendVersion(fetcher);

  const imageCount = countImages(payload.messages);
  const canVision = !!(entry && entry.attachment) || !!(staticCaps && staticCaps.vision);
  if (imageCount && !canVision)
    throw new ZaiWebError(400, 'Z.ai model "' + unprefixedModelId(modelId) + '" does not advertise image input.', "zai_vision_unsupported");

  // Pace Z.AI uploads through the same global lane, while arbitrary public
  // image downloads only use the vision module's SSRF guard/timeouts.
  const visionFetch = async (url, init) => {
    let host = "";
    try { host = new URL(String(url)).hostname; } catch {}
    if (host === "chat.z.ai")
      await awaitWafSlot();
    return fetcher(url, init);
  };

  let vision;
  try {
    vision = imageCount
      ? await processZaiVisionMessages(payload.messages || [], { token, fetchImpl: visionFetch })
      : { messages: structuredClone(payload.messages || []), files: [], imageParts: [] };
  } catch (e) {
    const status = Number(e && e.status) || 400;
    const code = String(e && e.code || "zai_vision");
    throw new ZaiWebError(status, "Z.ai image processing failed: " + String(e && e.message || e).slice(0, 240), code);
  }

  const prepared = prepareZaiTurn({ ...payload, messages: vision.messages });
  let messages = prepared.messages;
  if (prepared.shim.active && vision.imageParts.length)
    messages = attachZaiImageParts(messages, vision.imageParts);
  const prompt = prepared.shim.active ? prepared.prompt : referencePrompt(messages);
  if (!prompt && !vision.files.length)
    throw new ZaiWebError(400, "Z.ai requires at least one user message.", "zai_no_prompt");

  const thinking = resolveThinking(modelId, payload, entry);
  const features = resolveFeatures(payload, prepared.shim.active);
  const poolKey = String(route.zai_session_key || route.route_id || route.id || ("uid:" + userId));
  const { chatId } = acquireZaiChatId(poolKey, route.zai_session_pool_size);

  const storePath = (c && c.env && c.env.ZAI_TOKEN_STORE) || route.token_store_path || undefined;
  const proofMode = options.proofMode || "caller";

  const getProof = async () => {
    if (proofMode === "caller") {
      if (!parsed.captcha)
        throw new ZaiWebError(503, "Z.ai needs a fresh captcha proof for this completion.", "zai_captcha");
      return parsed.captcha;
    }
    const minted = await getZaiCaptchaProof({ storePath, fetchImpl: fetcher });
    if (!minted || !minted.ok || !minted.param) {
      const reason = String(minted && minted.reason || "");
      const empty = reason !== "captcha-config" && minted && Number(minted.remaining) === 0;
      const configMissing = reason === "captcha-config";
      throw new ZaiWebError(503,
        configMissing
          ? "Z.ai captcha minting is not configured on this host."
          : empty
            ? "Z.ai device-token store is empty or exhausted."
            : "Z.ai captcha proof generation failed.",
        configMissing ? "zai_captcha_config" : empty ? "zai_tokens" : "zai_captcha");
    }
    return minted.param;
  };

  const postOnce = async (proof) => {
    await awaitWafSlot();
    const timestamp = Date.now();
    const requestId = crypto.randomUUID();
    const signature = await buildSignature({ prompt, requestId, timestamp, userId });
    const url = buildReferenceCompletionUrl({ requestId, timestamp, token, userId });
    const body = buildReferenceCompletionBody({
      captchaVerifyParam: proof,
      chatId,
      messages,
      modelId,
      prompt,
      thinking,
      features,
      files: vision.files
    });
    return fetcher(url, {
      method: "POST",
      headers: session.headers({
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-Signature": signature,
        "X-Region": "overseas"
      }),
      body: JSON.stringify(body)
    });
  };

  let up = null;
  let lastProof = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      lastProof = await getProof();
      up = await postOnce(lastProof);
      session.noteResponse(up.headers);
      if (up.status !== 401)
        break;

      // Match the reference: refresh auth once, then perform a fresh attempt.
      // Minted mode obtains a NEW CAPTCHA on the next loop iteration because
      // proofs are single-use. Caller-proof mode can only retry the supplied
      // proof, which is still useful when the 401 rejected before captcha use.
      session.invalidate("completion 401");
      const again = await session.refresh("completion 401");
      if (!again || !again.token)
        break;
      token = again.token;
      userId = again.userId || userIdFromToken(token) || userId;
    }
  } catch (e) {
    releaseZaiChatId(poolKey, chatId, () => Promise.resolve());
    if (e instanceof ZaiWebError)
      throw e;
    if (e instanceof ZaiWafBlockedError)
      throw asWafError(e);
    throw new ZaiWebError(502, "Z.ai completion request failed: " + String(e && e.message || e).slice(0, 240), "zai_unreachable");
  }

  if (!up || !up.ok || !up.body) {
    const status = Number(up && up.status) || 502;
    const text = up ? String(await up.text().catch(() => "")).slice(0, 300) : "";
    if (isZaiWafBlock(status, text)) {
      const state = zaiWaf.recordBlock("reference-http");
      const err = new ZaiWebError(503, "Z.ai temporarily blocked this gateway egress.", "zai_waf");
      err.retryAfterSec = state.retryAfterSec;
      throw err;
    }
    if (/captcha\s+verification\s+failed/i.test(text))
      throw new ZaiWebError(502, "Z.ai rejected the freshly minted captcha proof.", "zai_captcha_rejected");
    throw new ZaiWebError(status, "Z.ai completion error: " + text, "zai_completion");
  }

  zaiWaf.recordSuccess();

  // Adopt any token rotation captured by the session cookie jar. The provider
  // key persistence layer above this adapter will reseal it after the call.
  const recovered = session.token && session.token !== active.token ? session.token : null;
  const id = "chatcmpl-zai-" + Date.now().toString(36);
  const promptTokens = estimatePromptTokens(messages, payload.tools ? JSON.stringify(payload.tools).length : 0) +
    imageCount * IMAGE_TOKEN_ALLOWANCE;

  const cleanup = async (idToDelete) => {
    if (!idToDelete || zaiWaf.status().blocked)
      return;
    try {
      await awaitWafSlot();
      const res = await fetcher(ZAI_DELETE_CHAT_URL(idToDelete), {
        method: "DELETE",
        headers: session.headers({ Accept: "application/json", "Content-Type": "application/json" })
      });
      if (res.status === 401) {
        session.invalidate("chat delete 401");
        await session.refresh("chat delete 401").catch(() => {});
        await awaitWafSlot();
        await fetcher(ZAI_DELETE_CHAT_URL(idToDelete), {
          method: "DELETE",
          headers: session.headers({ Accept: "application/json", "Content-Type": "application/json" })
        }).catch(() => {});
      }
    } catch {
      // Stateless chat GC is best-effort and must never change the client result.
    }
  };

  if (isStream) {
    const [clientStream, drainStream] = up.body.tee();
    const shaped = shapeFrameResponse({
      id,
      model: route.upstream_model || modelId,
      source: clientStream,
      promptTokens,
      isStream,
      recovered,
      agent: prepared.shim.active,
      tools: payload.tools || payload.functions || []
    });
    void (async () => {
      try {
        const reader = drainStream.getReader();
        while (!(await reader.read()).done) {}
      } catch {
      } finally {
        releaseZaiChatId(poolKey, chatId, cleanup);
      }
    })();
    return shaped;
  }

  try {
    return await shapeFrameResponse({
      id,
      model: route.upstream_model || modelId,
      source: up.body,
      promptTokens,
      isStream,
      recovered,
      agent: prepared.shim.active,
      tools: payload.tools || payload.functions || []
    });
  } finally {
    releaseZaiChatId(poolKey, chatId, cleanup);
  }
}

// Caller-proof mode remains available for debugging/manual integrations, but
// now uses the same proven HTTP wire as the automatic minted route.
export async function callZaiWeb(c, route, rawKey, payload, isStream, fetchImpl) {
  return runReferenceZaiHttp(c, route, rawKey, payload, isStream, {
    fetchImpl: fetchImpl || (c && c.upstreamFetch),
    proofMode: "caller"
  });
}

export function isWafChallenge(status, body) {
  return isZaiWafBlock(status, body);
}

// One converter for both transports: the signed HTTP path and the browser path
// hand over the same chat.z.ai frame stream, so the OpenAI mapping lives here
// rather than twice.
async function shapeFrameResponse(input) {
  const { id, model, source, promptTokens, isStream, recovered, agent, tools = [] } = input;
  if (isStream) {
    const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };
    return { response: new Response(toOpenAiStream(source, model, id, !!agent, tools), { status: 200, headers }), usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens, cost_usd: 0 }, recovered };
  }

  // Non-streaming: drain the same frame stream into a single completion body.
  let content = "";
  let reasoning = "";
  let failure = null;
  await readDeltas(source, (delta) => {
    if (delta.error) {
      failure = delta.error;
      return true;
    }
    if (delta.reasoning)
      reasoning += delta.reasoning;
    if (delta.content)
      content += delta.content;
    return delta.done;
  }, { holdback: Number.MAX_SAFE_INTEGER });
  if (failure)
    throw new ZaiWebError(502, "Z.ai stream failed: " + failure, "zai_stream_error");
  let finishReason = "stop";
  const message = { role: "assistant", content };
  if (agent) {
    const calls = parseAgentToolCalls(content, tools);
    content = stripAgentToolCalls(content);
    message.content = content;
    if (calls.length) {
      message.tool_calls = calls;
      finishReason = "tool_calls";
    }
  }
  if (reasoning)
    message.reasoning_content = reasoning;
  const completionTokens = Math.ceil(content.length / OUTPUT_CHARS_PER_TOKEN);
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost_usd: 0 };
  const body = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
  };
  return { response: new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }), usage, recovered };
}

// Rebuild the stored credential with a rotated token, preserving the rest of
// the JSON bag (the captcha proof, for instance). Rotation must not drop the
// fields the next request still needs.
export function withRotatedToken(rawKey, newToken) {
  const key = String(rawKey == null ? "" : rawKey);
  if (!key.trim().startsWith("{"))
    return newToken;
  try {
    const json = JSON.parse(key);
    return JSON.stringify({ ...json, token: newToken });
  } catch {
    return newToken;
  }
}

export function isZaiWebFormat(value) {
  const fmt2 = String(value || "").toLowerCase();
  return fmt2 === "zaiweb" || fmt2 === "zaiwebbrowser" || fmt2 === "zaiminted";
}

export function isZaiMintedFormat(value) {
  return String(value || "").toLowerCase() === "zaiminted";
}

/** Automatic pure-HTTP mode: GLM-Free-API style CAPTCHA mint + completion.
 *
 * Chromium is only a secondary escape hatch when the local proof infrastructure
 * is unavailable/exhausted. Confirmed WAF blocks, model errors, request errors,
 * and image requests never fall back to the browser.
 */
export async function callZaiMinted(c, route, rawKey, payload, isStream, fetchImpl) {
  try {
    return await runReferenceZaiHttp(c, route, rawKey, payload, isStream, {
      fetchImpl: fetchImpl || ((url, init) => upstreamFetch(c, url, init)),
      proofMode: "minted"
    });
  } catch (primary) {
    const browserFallback = String(process.env.ZAI_BROWSER_FALLBACK || "1").toLowerCase() !== "0" &&
      String(process.env.ZAI_BROWSER_FALLBACK || "1").toLowerCase() !== "false";
    const code = String(primary && primary.code || "");
    const proofFailure = code === "zai_tokens" || code === "zai_captcha" ||
      code === "zai_captcha_config" || code === "zai_captcha_rejected";
    if (!browserFallback || !proofFailure || countImages(payload && payload.messages))
      throw primary;

    try {
      return await callZaiBrowser(c, route, rawKey, payload, isStream);
    } catch (fallback) {
      const err = new ZaiWebError(
        Number(primary && primary.status) || 503,
        "Z.ai pure-HTTP proof path failed (" + code + "); browser fallback also failed (" +
          String(fallback && fallback.code || "zai_browser") + ").",
        "zai_http_fallback_failed"
      );
      err.primaryCode = code;
      err.fallbackCode = String(fallback && fallback.code || "zai_browser");
      throw err;
    }
  }
}

export function isZaiBrowserFormat(value) {
  return String(value || "").toLowerCase() === "zaiwebbrowser";
}

// Browser-backed transport: no captcha from the caller, because the page makes
// the call itself. Requires the Node host for Chromium.
export async function callZaiBrowser(c, route, rawKey, payload, isStream) {
  const modelId = route.upstream_model || payload.model || ZAI_DEFAULT_MODEL;
  const caps = getModelCapabilities(modelId);
  if (!caps)
    throw new ZaiWebError(503, 'Z.ai consumer model "' + unprefixedModelId(modelId) + '" is not a known chat.z.ai model (glm-5.3, glm-5.3-flash, glm-5.2).', "zai_model");
  const images = countImages(payload.messages);
  if (images)
    throw new ZaiWebError(400, "Z.ai web transports do not upload image bytes yet; the router was told vision=false, so this request should have rerouted.", "zai_vision_unsupported");

  const { token } = parseCredential(rawKey, payload);
  if (!token || !userIdFromToken(token))
    throw credentialError();

  const prepared = prepareZaiTurn(payload);
  const messages = prepared.messages;
  const prompt = prepared.shim.active ? prepared.prompt : foldPrompt(payload.messages || [], payload.system);
  if (!prompt)
    throw new ZaiWebError(400, "Z.ai requires at least one user message.", "zai_no_prompt");

  const registryFetcher = (c && c.upstreamFetch) || globalThis.fetch;
  const session = sessionFor({ fetcher: registryFetcher, credential: token, key: route.zai_session_key });
  const registry = registryFor({ session, fetcher: registryFetcher, fallback: (id) => modelCatalogEntry(id) });
  const entry = await registry.resolve(modelId);
  if (entry && entry.available === false)
    throw new ZaiWebError(503, 'Z.ai model "' + unprefixedModelId(modelId) + '" is not available for this account.', "zai_model_unavailable");

  assertWafAvailable();
  const { runBrowserTurn, ZaiBrowserUnavailable } = c && c.zaiRunBrowserTurn
    ? { runBrowserTurn: c.zaiRunBrowserTurn, ZaiBrowserUnavailable: class extends Error {} }
    : await import("./zaibrowser.js");
  let turn;
  try {
    turn = await runBrowserTurn(token, prompt, {
      turnTimeoutMs: Number(payload.turn_timeout_ms) || 0,
      // chat.z.ai rotates the JWT after successful turns. Pooling by the raw
      // token makes every next request cold-start a new browser context.
      poolId: browserPoolIdForToken(token)
    });
  } catch (e) {
    if (e instanceof ZaiBrowserUnavailable)
      throw new ZaiWebError(e.status || 503, e.message, e.code || "zai_browser_unavailable");
    throw new ZaiWebError(502, "Z.AI browser transport failed: " + String(e && e.message || e).slice(0, 300), "zai_browser");
  }

  zaiWaf.recordSuccess();
  const id = "chatcmpl-zaib-" + Date.now().toString(36);
  const promptTokens = estimatePromptTokens(messages, 0) + images * IMAGE_TOKEN_ALLOWANCE;
  // The frame converter reads a stream; wrap the captured response text.
  const source = new Response(turn.body).body || new Response("").body;
  return shapeFrameResponse({ id, model: route.upstream_model || modelId, source, promptTokens, isStream, recovered: turn.recovered || null, agent: prepared.shim.active, tools: payload.tools || payload.functions || [] });
}

// Rebuild the caller's conversation into one prompt for the browser transport.
function foldPrompt(messages, system) {
  const out = [];
  if (typeof system === "string" && system.trim())
    out.push("SYSTEM:\n" + system.trim());
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m)
      continue;
    const text = foldText(m.content);
    if (!text.trim())
      continue;
    const role = m.role === "assistant" ? "ASSISTANT" : m.role === "system" || m.role === "developer" ? "SYSTEM" : "USER";
    out.push(role + ":\n" + text);
  }
  return out.join("\n\n");
}

function foldText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object")
      continue;
    if (typeof part.text === "string")
      parts.push(part.text);
    else if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string")
      parts.push("[image: " + part.image_url.url.slice(0, 2048) + "]");
  }
  return parts.join("\n");
}

// Probe used by the admin "test provider" button: reports whether the stored
// credential is a live chat.z.ai session.
export async function validateZaiWebKey(rawKey, fetchImpl) {
  const fetcher = fetchImpl || fetch;
  const token = parseCredential(rawKey, null).token;
  if (!token)
    return { ok: false, status: 400, error: "No chat.z.ai session token found in the credential." };
  try {
    const res = await fetcher(ZAI_SETTINGS_URL, {
      headers: { Accept: "application/json, text/plain, */*", Authorization: "Bearer " + token, Origin: ZAI_BASE_URL, Referer: ZAI_BASE_URL + "/" }
    });
    if (res.ok)
      return { ok: true, status: res.status, error: null };
    if (res.status === 401)
      return { ok: false, status: 401, error: "Z.ai web session expired — paste a fresh token from chat.z.ai localStorage." };
    return { ok: false, status: res.status, error: "Z.ai session probe returned HTTP " + res.status };
  } catch (e) {
    return { ok: false, status: 0, error: "Z.ai session probe failed: " + String(e && e.message || e).slice(0, 200) };
  }
}

export const __zaiTest = {
  extractToken,
  captureVerifyParam,
  userIdFromToken,
  buildSignature,
  buildCompletionUrl,
  buildReferenceCompletionUrl,
  buildReferenceCompletionBody,
  buildReferenceFeatures,
  referenceHttpModelId,
  buildNewChatBody,
  buildCompletionBody,
  foldMessages,
  latestUserPrompt,
  referencePrompt,
  resolveThinking,
  resolveFeatures,
  upstreamModelId,
  getModelCapabilities,
  modelCatalogEntry,
  isZaiModel,
  toOpenAiStream,
  estimatePromptTokens,
  parseCredential,
  captureFromHeaders,
  isWafChallenge,
  wrapUtlsFetcher,
  browserPoolIdForToken
};

export const __test = { toOpenAiStream };
