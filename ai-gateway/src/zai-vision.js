// Z.AI vision upload pipeline.
//
// Wire shape adapted from GLM-Free-API (MIT, see THIRD_PARTY_NOTICES.md):
// image_url parts are uploaded to POST /api/v1/files/, the original content
// part is rewritten to reference the returned file id, and a top-level files[]
// entry mirrors the web client.
//
// Gateway-specific hardening retained/added:
// - SSRF protection for remote image URLs (public DNS/IPs only);
// - caller-supplied fetch implementation for routing/tests;
// - no temporary files and bounded image count/size.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_IMAGES = Math.max(1, Number(process.env.ZAI_MAX_IMAGES) || 10);
const MAX_IMAGE_BYTES = Math.max(1024, Number(process.env.ZAI_MAX_IMAGE_BYTES) || 50 * 1024 * 1024);
const DOWNLOAD_TIMEOUT_MS = Math.max(1000, Number(process.env.ZAI_IMAGE_DOWNLOAD_TIMEOUT_MS) || 60_000);
const UPLOAD_TIMEOUT_MS = Math.max(1000, Number(process.env.ZAI_IMAGE_UPLOAD_TIMEOUT_MS) || 120_000);
const UPLOAD_WORKERS = Math.max(1, Number(process.env.ZAI_IMAGE_UPLOAD_WORKERS) || 4);
const ZAI_FILES_URL = "https://chat.z.ai/api/v1/files/";

function extractUrl(part) {
  return part && part.type === "image_url" && part.image_url &&
    typeof part.image_url.url === "string" ? part.image_url.url.trim() : "";
}

function ipv4Private(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
    return true;
  return p[0] === 10 ||
    p[0] === 127 ||
    p[0] === 0 ||
    p[0] === 169 && p[1] === 254 ||
    p[0] === 172 && p[1] >= 16 && p[1] <= 31 ||
    p[0] === 192 && p[1] === 168 ||
    p[0] === 100 && p[1] >= 64 && p[1] <= 127 ||
    p[0] >= 224;
}

function ipv6Private(ip) {
  const v = ip.toLowerCase();
  return v === "::" || v === "::1" ||
    v.startsWith("fc") || v.startsWith("fd") ||
    /^fe[89ab]/.test(v) ||
    v.startsWith("ff") ||
    v.startsWith("2001:db8:");
}

export function isPublicImageAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return !ipv4Private(ip);
  if (family === 6) return !ipv6Private(ip);
  return false;
}

async function assertPublicRemoteUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("unsupported image URL scheme");
  if (url.username || url.password)
    throw new Error("credential-bearing image URLs are not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (!isPublicImageAddress(hostname))
      throw new Error("private or non-public image address is not allowed");
    return url;
  }
  const answers = await lookup(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((a) => !isPublicImageAddress(a.address)))
    throw new Error("image host resolves to a private or non-public address");
  return url;
}

function extensionForMime(mime) {
  switch (String(mime || "").toLowerCase().split(";")[0].trim()) {
    case "image/png": return ".png";
    case "image/jpeg":
    case "image/jpg": return ".jpg";
    case "image/gif": return ".gif";
    case "image/webp": return ".webp";
    case "image/bmp": return ".bmp";
    case "image/svg+xml": return ".svg";
    case "image/tiff": return ".tiff";
    case "image/avif": return ".avif";
    default: return ".bin";
  }
}

function safeFilename(name, mime) {
  const cleaned = String(name || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return cleaned && cleaned !== "." ? cleaned : "image" + extensionForMime(mime);
}

function decodeDataUrl(raw) {
  const comma = raw.indexOf(",");
  if (comma < 5) throw new Error("malformed data URL");
  const meta = raw.slice(5, comma);
  const payload = raw.slice(comma + 1);
  const parts = meta.split(";");
  const mime = parts[0] || "application/octet-stream";
  if (!parts.slice(1).some((p) => p.toLowerCase() === "base64"))
    throw new Error("only base64 data URLs are supported");
  let data;
  try {
    data = Buffer.from(payload, "base64");
  } catch {
    throw new Error("invalid base64 image");
  }
  if (!data.length) throw new Error("empty image");
  if (data.length > MAX_IMAGE_BYTES)
    throw new Error("image exceeds max size of " + MAX_IMAGE_BYTES + " bytes");
  return { data, filename: "image" + extensionForMime(mime), contentType: mime };
}

async function downloadImage(rawUrl, fetchImpl) {
  const url = await assertPublicRemoteUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await (fetchImpl || fetch)(url.toString(), {
      method: "GET",
      headers: { Accept: "image/*,*/*;q=0.8" },
      signal: controller.signal,
      redirect: "error"
    });
    if (!res.ok)
      throw new Error("image download returned " + res.status);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES)
      throw new Error("image exceeds max size of " + MAX_IMAGE_BYTES + " bytes");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new Error("image exceeds max size of " + MAX_IMAGE_BYTES + " bytes");
    let mime = String(res.headers.get("content-type") || "").split(";")[0].trim();
    if (!mime.startsWith("image/"))
      mime = "application/octet-stream";
    const base = decodeURIComponent(url.pathname.split("/").pop() || "");
    return { data: bytes, filename: safeFilename(base, mime), contentType: mime };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveImage(rawUrl, fetchImpl) {
  return rawUrl.startsWith("data:") ? decodeDataUrl(rawUrl) : downloadImage(rawUrl, fetchImpl);
}

function buildFileEntry(fileObj, image, refUserMsgId) {
  const id = String(fileObj && fileObj.id || "");
  const metaSize = Number(fileObj && fileObj.meta && fileObj.meta.size);
  return {
    type: "image",
    file: fileObj,
    id,
    url: "/api/v1/files/" + id,
    name: String(fileObj && fileObj.filename || image.filename),
    status: "uploaded",
    size: Number.isFinite(metaSize) && metaSize > 0 ? metaSize : image.data.length,
    error: "",
    itemId: crypto.randomUUID(),
    media: "image",
    uploadedAt: Date.now(),
    ref_user_msg_id: refUserMsgId
  };
}

async function uploadImage(image, token, fetchImpl) {
  const form = new FormData();
  form.append("file", new Blob([image.data], { type: image.contentType || "application/octet-stream" }), image.filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await (fetchImpl || fetch)(ZAI_FILES_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      },
      body: form,
      signal: controller.signal
    });
    const text = await res.text();
    if (res.status === 401)
      throw Object.assign(new Error("file upload unauthorized"), { code: "zai_vision_auth", status: 401 });
    if (!res.ok)
      throw new Error("file upload failed: " + res.status + " " + text.slice(0, 160));
    let obj;
    try { obj = JSON.parse(text); } catch { throw new Error("file upload returned invalid JSON"); }
    if (!obj || !obj.id)
      throw new Error("file upload response missing file id");
    return obj;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export function extractZaiImageParts(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const part of message.content)
      if (extractUrl(part))
        out.push(structuredClone(part));
  }
  return out;
}

export function attachZaiImageParts(messages, imageParts) {
  if (!imageParts || !imageParts.length) return messages;
  const out = structuredClone(Array.isArray(messages) ? messages : []);
  let target = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && out[i].role === "user") { target = i; break; }
  }
  if (target < 0) target = Math.max(0, out.length - 1);
  if (!out[target]) out[target] = { role: "user", content: [] };
  const content = out[target].content;
  const parts = Array.isArray(content)
    ? content.slice()
    : content == null || content === ""
      ? []
      : [{ type: "text", text: String(content) }];
  parts.push(...imageParts.map((p) => structuredClone(p)));
  out[target].content = parts;
  return out;
}

export async function processZaiVisionMessages(messages, { token, fetchImpl } = {}) {
  const source = structuredClone(Array.isArray(messages) ? messages : []);
  const found = [];
  const refIds = new Map();
  for (let mi = 0; mi < source.length; mi++) {
    const msg = source[mi];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let pi = 0; pi < msg.content.length; pi++) {
      const url = extractUrl(msg.content[pi]);
      if (!url) continue;
      if (!refIds.has(mi)) refIds.set(mi, crypto.randomUUID());
      found.push({ mi, pi, url });
    }
  }
  if (!found.length)
    return { messages: source, files: [], imageParts: [] };
  if (!token)
    throw Object.assign(new Error("Z.AI vision requires an authenticated account token"), { code: "zai_vision_auth", status: 401 });
  if (found.length > MAX_IMAGES)
    throw Object.assign(new Error("too many images: " + found.length + " (max " + MAX_IMAGES + ")"), { code: "zai_vision_limit", status: 400 });

  const uploaded = await mapLimit(found, UPLOAD_WORKERS, async (item) => {
    const image = await resolveImage(item.url, fetchImpl);
    const fileObj = await uploadImage(image, token, fetchImpl);
    return { item, entry: buildFileEntry(fileObj, image, refIds.get(item.mi)) };
  });

  const files = [];
  for (const { item, entry } of uploaded) {
    const part = source[item.mi].content[item.pi];
    part.image_url.url = entry.id;
    files.push(entry);
  }
  return { messages: source, files, imageParts: extractZaiImageParts(source) };
}

export const __zaiVisionTest = {
  extractUrl,
  decodeDataUrl,
  buildFileEntry,
  extensionForMime,
  safeFilename,
  MAX_IMAGES,
  MAX_IMAGE_BYTES
};
