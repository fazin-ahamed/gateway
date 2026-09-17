// Z.ai consumer chat (chat.z.ai) provider adapter.
//
// An OpenAI-compatible front for Z.ai's web chat: the consumer site
// authenticates with a Bearer JWT from localStorage and requires a
// browser-issued CAPTCHA proof, then takes a signed completion call.
//
// Transport here is signed HTTP only — no browser automation. That means a
// route works when the operator supplies both the session token and a
// (short-lived) captcha proof; without a proof the provider returns a clear
// 503 telling the operator what to paste, instead of failing opaquely.
//
// Wire shape ported from OmniRoute (open-sse/executors/zai-web) so both
// gateways speak the identical protocol.

const ZAI_BASE_URL = "https://chat.z.ai";
const ZAI_NEW_CHAT_URL = ZAI_BASE_URL + "/api/v1/chats/new";
const ZAI_CHAT_URL = ZAI_BASE_URL + "/api/v2/chat/completions";
const ZAI_SETTINGS_URL = ZAI_BASE_URL + "/api/v1/users/user/settings";
const ZAI_DEFAULT_MODEL = "glm-5.3";
const ZAI_DEFAULT_FE_VERSION = "prod-fe-1.1.92";
const ZAI_FE_VERSION_CACHE_MS = 15 * 60 * 1000;
const ZAI_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
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
    toolCall: false,
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
  const encodedPrompt = bytesToBase64(new TextEncoder().encode(input.prompt));
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
    // chat.z.ai's signed API takes no inline image parts; keep the URL so the
    // model at least sees that an image was referenced instead of silently
    // losing it.
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

// The consumer models expose an effort selector but no non-thinking mode, so
// a client asking for "none"/"off" still gets thinking, at the lowest effort
// the model actually supports (low on 5.3, high on 5.2). Never map off→max.
function resolveThinking(modelId, payload) {
  const caps = getModelCapabilities(modelId);
  if (!caps || !caps.thinking)
    return { enabled: false, effort: "high", effortSupported: false };
  const reasoning = payload && payload.reasoning;
  const raw = typeof payload?.reasoning_effort === "string"
    ? payload.reasoning_effort.trim().toLowerCase()
    : typeof reasoning?.effort === "string"
      ? reasoning.effort.trim().toLowerCase()
      : "";
  const supportsLow = capabilityModelId(modelId) !== "glm-5.2";
  let effort;
  if (!raw || raw === "none" || raw === "off" || raw === "nothink" || raw === "low")
    effort = supportsLow ? "low" : "high";
  else if (raw === "medium" || raw === "high")
    effort = "high";
  else if (raw === "max" || raw === "xhigh")
    effort = "max";
  else
    effort = supportsLow ? "low" : "high";
  return { enabled: true, effort, effortSupported: true };
}

// Web search / tools switches shown in the site UI. Defaults off: the gateway
// never silently upgrades a request into a search or agent turn.
function resolveFeatures(payload) {
  const opt = (key) => payload && (payload[key] !== undefined ? payload[key] : payload.features?.[key]);
  const webSearch = opt("web_search") ?? opt("auto_web_search");
  return { toolsEnabled: opt("vlm_tools_enable") === true, webSearchEnabled: webSearch === true };
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

// One parsed delta from chat.z.ai: text and/or reasoning, plus terminal flags.
function parseFrame(raw) {
  if (!raw || typeof raw !== "object")
    return null;
  const frame = raw;
  const data = frame.data && typeof frame.data === "object" ? frame.data : frame;
  const rawError = frame.error ?? data.error;
  if (rawError) {
    const message = typeof rawError === "string" ? rawError : rawError.message || rawError.detail || rawError.msg || JSON.stringify(rawError);
    return { content: "", reasoning: "", done: true, error: String(message).slice(0, 500) };
  }
  const choices = Array.isArray(frame.choices) ? frame.choices : null;
  if (choices && choices.length) {
    const delta = choices[0].delta || {};
    return {
      content: typeof delta.content === "string" ? delta.content : "",
      reasoning: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "",
      done: choices[0].finish_reason != null
    };
  }
  const phase = String(data.phase || "");
  const deltaContent = data.delta_content ?? data.edit_content ?? data.content;
  const done = data.done === true || phase === "done" || phase === "finish" || String(frame.type || "") === "chat:completion:finish";
  if (typeof deltaContent === "string" && deltaContent)
    return { content: phase === "thinking" ? "" : deltaContent, reasoning: phase === "thinking" ? deltaContent : "", done };
  if (done)
    return { content: "", reasoning: "", done: true };
  return null;
}

// ch.at.z.ai streams SSE in the same frames whether or not the client asked
// for streaming, so both response modes read through this reader.
async function readDeltas(source, onDelta) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done)
        break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:"))
          continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]")
          continue;
        let frame = null;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = parseFrame(frame);
        if (delta && onDelta(delta))
          return;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
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
// choices[0] and choke on `choices: []`).
function toOpenAiStream(source, model, id) {
  const created = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  let started = false;
  let finished = false;
  let chars = 0;
  return new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
      const finish = () => {
        if (finished)
          return;
        finished = true;
        const usage = { prompt_tokens: 0, completion_tokens: Math.ceil(chars / OUTPUT_CHARS_PER_TOKEN), total_tokens: Math.ceil(chars / OUTPUT_CHARS_PER_TOKEN), cost_usd: 0 };
        send(chunk(id, created, model, {}, "stop", usage));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
      };
      try {
        await readDeltas(source, (delta) => {
          if (delta.error) {
            send({ error: { message: "Z.ai stream failed: " + delta.error, type: "upstream_error", code: "zai_stream_error" } });
            finish();
            return true;
          }
          if (!started && (delta.content || delta.reasoning)) {
            started = true;
            send(chunk(id, created, model, { role: "assistant", content: "" }));
          }
          if (delta.reasoning)
            send(chunk(id, created, model, { reasoning_content: delta.reasoning }));
          if (delta.content) {
            chars += delta.content.length;
            send(chunk(id, created, model, { content: delta.content }));
          }
          if (delta.done) {
            finish();
            return true;
          }
          return false;
        });
        if (!finished) {
          if (!started)
            send(chunk(id, created, model, { role: "assistant", content: "" }));
          finish();
        }
        controller.close();
      } catch (e) {
        try {
          controller.error(e);
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
  }
}

function credentialError() {
  return new ZaiWebError(503, 'Z.ai route needs a web session: put the chat.z.ai localStorage "token" in the provider key.', "zai_credentials");
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

// Runs one chat turn against chat.z.ai and returns an OpenAI-shaped stream or
// JSON body, matching the { response, usage } contract of forwardToProvider.
export async function callZaiWeb(c, route, rawKey, payload, isStream, fetchImpl) {
  const fetcher = fetchImpl || c.upstreamFetch;
  const modelId = route.upstream_model || payload.model || ZAI_DEFAULT_MODEL;
  const caps = getModelCapabilities(modelId);
  if (!caps)
    throw new ZaiWebError(503, 'Z.ai consumer model "' + unprefixedModelId(modelId) + '" is not a known chat.z.ai model (glm-5.3, glm-5.3-flash, glm-5.2).', "zai_model");
  if (payload.tools || payload.functions)
    throw new ZaiWebError(400, "Z.ai consumer models do not accept caller-supplied tools; use an API-key Z.AI provider for tool calling.", "zai_tools_unsupported");
  const images = countImages(payload.messages);
  if (images && !caps.vision)
    throw new ZaiWebError(400, "Z.ai model " + unprefixedModelId(modelId) + " does not accept image input; use glm-5.3-flash.", "zai_vision_unsupported");

  const { token, captcha } = parseCredential(rawKey, payload, c && c.req && typeof c.req.header === "function" ? {
    get: (name) => c.req.header(name)
  } : null);
  const userId = userIdFromToken(token);
  if (!token || !userId)
    throw credentialError();
  if (!captcha)
    throw new ZaiWebError(503, "Z.ai needs a fresh captcha proof for this completion. Pass it as the x-zai-captcha request header (or providerSpecificData), or store one in the provider key. It is issued per completion, so the stored value only works once.", "zai_captcha");

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const prompt = latestUserPrompt(messages);
  if (!prompt && !images)
    throw new ZaiWebError(400, "Z.ai requires at least one user message.", "zai_no_prompt");

  const thinking = resolveThinking(modelId, payload);
  const features = resolveFeatures(payload);
  const frontendVersion = await resolveFrontendVersion(fetcher);
  const userMessageId = crypto.randomUUID();

  // 1. Create the remote chat the completion is attached to.
  let created;
  try {
    created = await fetcher(ZAI_NEW_CHAT_URL, {
      method: "POST",
      headers: buildHeaders(token, { accept: "application/json", frontendVersion }),
      body: JSON.stringify(buildNewChatBody({
        messages,
        modelId,
        prompt,
        userMessageId,
        enableThinking: thinking.enabled,
        reasoningEffort: thinking.effort,
        features
      }).payload)
    });
  } catch (e) {
    throw new ZaiWebError(502, "Z.ai chat creation failed: " + String(e && e.message || e).slice(0, 300), "zai_unreachable");
  }
  if (!created.ok)
    throw new ZaiWebError(created.status, "Z.ai chat creation error: " + String(await created.text().catch(() => "")).slice(0, 300), "zai_chat_create");
  const createdJson = await created.json().catch(() => null);
  const chatId = createdJson && typeof createdJson.id === "string" ? createdJson.id : "";
  if (!chatId)
    throw new ZaiWebError(502, "Z.ai chat creation returned no chat id.", "zai_chat_create");

  // 2. Signed completion call.
  const timestamp = Date.now();
  const requestId = crypto.randomUUID();
  const signature = await buildSignature({ prompt, requestId, timestamp, userId });
  const completionUrl = buildCompletionUrl({ requestId, timestamp, token, userId });
  let up;
  try {
    up = await fetcher(completionUrl, {
      method: "POST",
      headers: buildHeaders(token, { accept: "text/event-stream", frontendVersion, signature }),
      body: JSON.stringify(buildCompletionBody({
        body: payload,
        captchaVerifyParam: captcha,
        chatId,
        messages,
        modelId,
        prompt,
        requestId,
        userMessageId,
        enableThinking: thinking.enabled,
        reasoningEffort: thinking.effort,
        effortSupported: thinking.effortSupported,
        features
      }))
    });
  } catch (e) {
    throw new ZaiWebError(502, "Z.ai completion request failed: " + String(e && e.message || e).slice(0, 300), "zai_unreachable");
  }
  if (!up.ok || !up.body)
    throw new ZaiWebError(up.status || 502, "Z.ai completion error: " + String(await up.text().catch(() => "")).slice(0, 300), "zai_completion");

  const id = "chatcmpl-zai-" + Date.now().toString(36);
  const promptTokens = estimatePromptTokens(messages, payload.tools ? JSON.stringify(payload.tools).length : 0) + images * IMAGE_TOKEN_ALLOWANCE;
  // chat.z.ai refreshes its session cookie on every chat creation. Capture the
  // rotated value so the stored provider key does not keep a token the site has
  // already retired (that is the "worked yesterday, 401 today" failure).
  const recovered = rotatedToken(created.headers) || token;
  return shapeFrameResponse({ id, model: route.upstream_model || modelId, source: up.body, promptTokens, isStream, recovered });
}

// One converter for both transports: the signed HTTP path and the browser path
// hand over the same chat.z.ai frame stream, so the OpenAI mapping lives here
// rather than twice.
async function shapeFrameResponse(input) {
  const { id, model, source, promptTokens, isStream, recovered } = input;
  if (isStream) {
    const headers = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" };
    return { response: new Response(toOpenAiStream(source, model, id), { status: 200, headers }), usage: { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens, cost_usd: 0 }, recovered };
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
  });
  if (failure)
    throw new ZaiWebError(502, "Z.ai stream failed: " + failure, "zai_stream_error");
  const message = { role: "assistant", content };
  if (reasoning)
    message.reasoning_content = reasoning;
  const completionTokens = Math.ceil(content.length / OUTPUT_CHARS_PER_TOKEN);
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost_usd: 0 };
  const body = {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: "stop" }],
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

/**
 * Minted transport: pure HTTP, no browser and no caller-supplied captcha.
 *
 * One flow per request, matching what the reference bridge does:
 *   1. create the chat (chat.z.ai materializes it on first completion)
 *   2. mint a captcha proof from a harvested device token
 *   3. POST the completion with that proof
 *
 * Device tokens are single-use, so each request consumes one from the store.
 */
export async function callZaiMinted(c, route, rawKey, payload, isStream, fetchImpl) {
  const fetcher = fetchImpl || ((url, init) => upstreamFetch(c, url, init));
  const modelId = route.upstream_model || payload.model || ZAI_DEFAULT_MODEL;
  const caps = getModelCapabilities(modelId);
  if (!caps)
    throw new ZaiWebError(503, 'Z.ai consumer model "' + unprefixedModelId(modelId) + '" is not a known chat.z.ai model (glm-5.3, glm-5.3-flash, glm-5.2).', "zai_model");
  if (payload.tools || payload.functions)
    throw new ZaiWebError(400, "Z.ai consumer models do not accept caller-supplied tools; use an API-key Z.AI provider for tool calling.", "zai_tools_unsupported");
  const images = countImages(payload.messages);
  if (images && !caps.vision)
    throw new ZaiWebError(400, "Z.ai model " + unprefixedModelId(modelId) + " does not accept image input; use glm-5.3-flash.", "zai_vision_unsupported");

  const { token } = parseCredential(rawKey, payload);
  const userId = userIdFromToken(token);
  if (!token || !userId)
    throw credentialError();

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const prompt = latestUserPrompt(messages);
  if (!prompt && !images)
    throw new ZaiWebError(400, "Z.ai requires at least one user message.", "zai_no_prompt");

  const { takeDeviceToken } = await import("./zai-tokens.js");
  const { mintCaptcha } = await import("./zai-captcha.js");
  const storePath = (c && c.env && c.env.ZAI_TOKEN_STORE) || route.token_store_path || undefined;

  const thinking = resolveThinking(modelId, payload);
  const features = resolveFeatures(payload);
  const frontendVersion = await resolveFrontendVersion(fetcher);
  const userMessageId = crypto.randomUUID();

  // 1. Create the chat.
  let created;
  try {
    created = await fetcher(ZAI_NEW_CHAT_URL, {
      method: "POST",
      headers: buildHeaders(token, { accept: "application/json", frontendVersion }),
      body: JSON.stringify(buildNewChatBody({
        messages,
        modelId,
        prompt,
        userMessageId,
        enableThinking: thinking.enabled,
        reasoningEffort: thinking.effort,
        features
      }).payload)
    });
  } catch (e) {
    throw new ZaiWebError(502, "Z.ai chat creation failed: " + String(e && e.message || e).slice(0, 300), "zai_unreachable");
  }
  if (!created.ok)
    throw new ZaiWebError(created.status, "Z.ai chat creation error: " + String(await created.text().catch(() => "")).slice(0, 300), "zai_chat_create");
  const createdJson = await created.json().catch(() => null);
  const chatId = createdJson && typeof createdJson.id === "string" ? createdJson.id : "";
  if (!chatId)
    throw new ZaiWebError(502, "Z.ai chat creation returned no chat id.", "zai_chat_create");

  // 2. Mint a proof, retrying with another token when Aliyun rejects one.
  let proof = null;
  let lastReason = "";
  let remaining = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = await takeDeviceToken(storePath);
    remaining = taken.remaining;
    if (!taken.token)
      break;
    const minted = await mintCaptcha(taken.token, { fetchImpl: fetcher });
    if (minted.ok) {
      proof = minted.param;
      break;
    }
    lastReason = minted.reason + (minted.detail ? ": " + String(minted.detail).slice(0, 160) : "");
  }
  if (!proof)
    throw new ZaiWebError(503, remaining === 0
      ? "Z.ai device-token store is empty (or exhausted). Harvest tokens and add them to the store; see docs/zai-minted.md."
      : "Z.ai captcha minting failed for " + 5 + " device tokens (" + lastReason + ").",
      "zai_tokens");

  // 3. Completion with the minted proof.
  const timestamp = Date.now();
  const requestId = crypto.randomUUID();
  const signature = await buildSignature({ prompt, requestId, timestamp, userId });
  const completionUrl = buildCompletionUrl({ requestId, timestamp, token, userId });
  let up;
  try {
    up = await fetcher(completionUrl, {
      method: "POST",
      headers: buildHeaders(token, { accept: "text/event-stream", frontendVersion, signature }),
      body: JSON.stringify(buildCompletionBody({
        body: payload,
        captchaVerifyParam: proof,
        chatId,
        messages,
        modelId,
        prompt,
        requestId,
        userMessageId,
        enableThinking: thinking.enabled,
        reasoningEffort: thinking.effort,
        effortSupported: thinking.effortSupported,
        features
      }))
    });
  } catch (e) {
    throw new ZaiWebError(502, "Z.ai completion request failed: " + String(e && e.message || e).slice(0, 300), "zai_unreachable");
  }
  if (!up.ok || !up.body)
    throw new ZaiWebError(up.status || 502, "Z.ai completion error: " + String(await up.text().catch(() => "")).slice(0, 300), "zai_completion");

  const id = "chatcmpl-zaim-" + Date.now().toString(36);
  const promptTokens = estimatePromptTokens(messages, 0) + images * IMAGE_TOKEN_ALLOWANCE;
  return shapeFrameResponse({ id, model: route.upstream_model || modelId, source: up.body, promptTokens, isStream, recovered: null });
}

export function isZaiBrowserFormat(value) {
  return String(value || "").toLowerCase() === "zaiwebbrowser";
}

// Browser-backed transport: no captcha from the caller, because the page makes
// the call itself. Requires the Node host (a browser cannot run in a Worker).
export async function callZaiBrowser(c, route, rawKey, payload, isStream) {
  const modelId = route.upstream_model || payload.model || ZAI_DEFAULT_MODEL;
  const caps = getModelCapabilities(modelId);
  if (!caps)
    throw new ZaiWebError(503, 'Z.ai consumer model "' + unprefixedModelId(modelId) + '" is not a known chat.z.ai model (glm-5.3, glm-5.3-flash, glm-5.2).', "zai_model");
  if (payload.tools || payload.functions)
    throw new ZaiWebError(400, "Z.ai consumer models do not accept caller-supplied tools; use an API-key Z.AI provider for tool calling.", "zai_tools_unsupported");
  const images = countImages(payload.messages);
  if (images && !caps.vision)
    throw new ZaiWebError(400, "Z.ai model " + unprefixedModelId(modelId) + " does not accept image input; use glm-5.3-flash.", "zai_vision_unsupported");

  const { token } = parseCredential(rawKey, payload);
  if (!token || !userIdFromToken(token))
    throw credentialError();

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const prompt = foldPrompt(messages, payload.system);
  if (!prompt)
    throw new ZaiWebError(400, "Z.ai requires at least one user message.", "zai_no_prompt");

  const { runBrowserTurn, ZaiBrowserUnavailable } = c && c.zaiRunBrowserTurn
    ? { runBrowserTurn: c.zaiRunBrowserTurn, ZaiBrowserUnavailable: class extends Error {} }
    : await import("./zaibrowser.js");
  let turn;
  try {
    turn = await runBrowserTurn(token, prompt, { turnTimeoutMs: Number(payload.turn_timeout_ms) || 0 });
  } catch (e) {
    if (e instanceof ZaiBrowserUnavailable)
      throw new ZaiWebError(e.status || 503, e.message, e.code || "zai_browser_unavailable");
    throw new ZaiWebError(502, "Z.AI browser transport failed: " + String(e && e.message || e).slice(0, 300), "zai_browser");
  }

  const id = "chatcmpl-zaib-" + Date.now().toString(36);
  const promptTokens = estimatePromptTokens(messages, 0) + images * IMAGE_TOKEN_ALLOWANCE;
  // The frame converter reads a stream; wrap the captured response text.
  const source = new Response(turn.body).body || new Response("").body;
  return shapeFrameResponse({ id, model: route.upstream_model || modelId, source, promptTokens, isStream, recovered: null });
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
  buildNewChatBody,
  buildCompletionBody,
  foldMessages,
  latestUserPrompt,
  resolveThinking,
  resolveFeatures,
  upstreamModelId,
  getModelCapabilities,
  modelCatalogEntry,
  isZaiModel,
  parseFrame,
  toOpenAiStream,
  estimatePromptTokens,
  parseCredential,
  captureFromHeaders
};
