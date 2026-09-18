// Canonical model identity vs operational route identity.
//
// Intelligence scores attach to a model. Health, TLS, credentials and
// rate-limits attach to a route. Slug punctuation must not change either.

const PUNCT = /[^a-z0-9]+/g;

export function normalizeModelId(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const last = raw.split("/").pop();
  return last
    .replace(/([a-z])(\d)/g, "$1-$2")
    .replace(PUNCT, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function modelFamily(modelId) {
  const id = normalizeModelId(modelId);
  if (id.startsWith("glm")) return "glm";
  if (id.startsWith("deepseek")) return "deepseek";
  if (id.startsWith("qwen")) return "qwen";
  if (id.startsWith("grok")) return "grok";
  if (id.startsWith("minimax")) return "minimax";
  if (id.startsWith("kimi") || id.startsWith("moonshot")) return "kimi";
  if (id.startsWith("laguna")) return "laguna";
  if (id.startsWith("agnes")) return "agnes";
  return id.split("-")[0] || "other";
}

export function isTinyModel(modelId) {
  const id = normalizeModelId(modelId);
  if (id.includes("minimax")) return false;
  return /(flash|^lite$|-lite-|-mini-|^mini$|small|^air$|nano|^xs$|-xs-)/.test(id);
}

export function routeKey(route) {
  const model = normalizeModelId(route && (route.upstream_model || route.model || route.slug));
  const provider = String(route && (route.provider_id || route.provider || "") || "0");
  const transport = String(route && (route.transport || route.fmt || "direct") || "direct").toLowerCase();
  const slug = String(route && route.slug || model);
  return [model, provider, transport, slug].join("|");
}

export function parseRouteKey(key) {
  const [model, provider, transport, slug] = String(key || "").split("|");
  return { model: model || "", provider: provider || "", transport: transport || "", slug: slug || model || "" };
}
