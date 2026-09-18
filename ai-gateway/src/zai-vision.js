// Z.AI vision upload pipeline.
//
// Adapted from GLM-Free-API's proven /api/v1/files/ flow (MIT; see
// THIRD_PARTY_NOTICES.md), with an extra gateway-side SSRF guard for remote
// image URLs. Images are uploaded before the completion and referenced by the
// returned file id exactly like the chat.z.ai frontend.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extname, basename } from "node:path";

const ZAI_FILES_URL = "https://chat.z.ai/api/v1/files/";
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const WORKERS = 4;

function isPrivateV4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
    return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
  if (p[0] >= 224) return true;
  return false;
}

function isPrivateV6(ip) {
  const s = String(ip || "").toLowerCase();
  if (s === "::" || s === "::1") return true;
  if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") ||
      s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb"))
    return true;
  if (s.startsWith("::ffff:")) {
    const tail = s.slice(7);
    return isIP(tail) === 4 ? isPrivateV4(tail) : true;
  }
  return false;
}

export function isPublicAddress(ip) {
  const family = isIP(String(ip || ""));
  if (family === 4) return !isPrivateV4(ip);
  if (family === 6) return !isPrivateV6(ip);
  return false;
}

async function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error("invalid image URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("unsupported image URL scheme");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host === "metadata.google.internal")
    throw new Error("image URL resolves to a non-public host");

  if (isIP(host)) {
    if (!isPublicAddress(host))
      throw new Error("image URL resolves to a private or special-use address");
    return u;
  }

  const answers = await lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some((a) => !isPublicAddress(a.address)))
    throw new Error("image URL resolves to a private or special-use address");
  return u;
}

function mimeExt(mime) {
  const m = String(mime || "").toLowerCase().split(";")[0].trim();
  return ({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/tiff": ".tiff",
    "image/avif": ".avif"
  })[m] || ".bin";
}

function safeFilename(name, mime) {
  const raw = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  if (raw && extname(raw))
    return raw;
  return (raw || "image") + mimeExt(mime);
}

function imageUrlFromPart(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "image_url" && part.image_url && typeof part.image_url.url === "string")
    return part.image_url.url.trim();
  if (part.type === "image" && part.source && typeof part.source === "object") {
    if (part.source.type === "url" && typeof part.source.url === "string")
      return part.source.url.trim();
    if (part.source.type === "base64" && typeof part.source.data === "string") {
      const mime = part.source.media_type || "image/png";
      return "data:" + mime + ";base64," + part.source.data;
    }
  }
  return "";
}

function parseDataUrl(raw) {
  const m = String(raw).match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/i);
  if (!m || !m[2])
    throw new Error("only base64 data URLs are supported");
  const mime = m[1] || "application/octet-stream";
  let data;
  try {
    data = Buffer.from(m[3], "base64");
  } catch {
    throw new Error("invalid base64 image");
  }
  if (data.length > MAX_IMAGE_BYTES)
    throw new Error("image exceeds 50 MB limit");
  return {
    data,
    contentType: mime,
    filename: safeFilename("image", mime)
  };
}

async function fetchImage(raw, imageFetch = globalThis.fetch) {
  if (String(raw).startsWith("data:"))
    return parseDataUrl(raw);

  const u = await assertPublicHttpUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const res = await imageFetch(u.toString(), {
      method: "GET",
      headers: { Accept: "image/*,*/*;q=0.8" },
      signal: controller.signal,
      redirect: "error"
    });
    if (!res.ok)
      throw new Error("image download returned HTTP " + res.status);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_IMAGE_BYTES)
      throw new Error("image exceeds 50 MB limit");
    const ab = await res.arrayBuffer();
    const data = Buffer.from(ab);
    if (data.length > MAX_IMAGE_BYTES)
      throw new Error("image exceeds 50 MB limit");
    const contentType = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const name = basename(decodeURIComponent(u.pathname || "")) || "image";
    return { data, contentType, filename: safeFilename(name, contentType) };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadOne({ img, session, fetcher }) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const active = await session.acquire();
    const form = new FormData();
    form.append("file", new Blob([img.data], { type: img.contentType }), img.filename);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const res = await fetcher(ZAI_FILES_URL, {
        method: "POST",
        headers: session.headers({ Accept: "application/json", Authorization: "Bearer " + active.token }),
        body: form,
        signal: controller.signal
      });
      session.noteResponse(res.headers);
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        session.invalidate("vision upload 401");
        await session.refresh("vision upload 401");
        last = new Error("file upload unauthorized (401)");
        continue;
      }
      if (!res.ok)
        throw new Error("file upload failed: HTTP " + res.status + " " + text.slice(0, 180));
      let file;
      try { file = JSON.parse(text); } catch { file = null; }
      if (!file || typeof file.id !== "string" || !file.id)
        throw new Error("file upload response missing file id");
      return file;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last || new Error("file upload failed");
}

function fileEntry(file, img, refUserMsgId) {
  const id = file.id;
  const size = Number(file && file.meta && file.meta.size) || img.data.length;
  return {
    type: "image",
    file,
    id,
    url: "/api/v1/files/" + id,
    name: file.filename || img.filename,
    status: "uploaded",
    size,
    error: "",
    itemId: crypto.randomUUID(),
    media: "image",
    uploadedAt: Date.now(),
    ref_user_msg_id: refUserMsgId
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export async function processZaiVision({ messages, session, fetcher, imageFetch = globalThis.fetch } = {}) {
  const cloned = JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : []));
  const found = [];
  const refs = new Map();

  for (let mi = 0; mi < cloned.length; mi++) {
    const msg = cloned[mi];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (let pi = 0; pi < msg.content.length; pi++) {
      const raw = imageUrlFromPart(msg.content[pi]);
      if (!raw) continue;
      if (!refs.has(mi)) refs.set(mi, crypto.randomUUID());
      found.push({ mi, pi, raw, refUserMsgId: refs.get(mi) });
    }
  }

  if (!found.length)
    return { messages: cloned, files: [], imageParts: [], imageCount: 0 };
  if (found.length > MAX_IMAGES)
    throw new Error("too many images: " + found.length + " provided, max " + MAX_IMAGES);

  const uploaded = await mapLimit(found, WORKERS, async (item) => {
    const img = await fetchImage(item.raw, imageFetch);
    const file = await uploadOne({ img, session, fetcher });
    return { item, img, file, entry: fileEntry(file, img, item.refUserMsgId) };
  });

  for (const row of uploaded) {
    const part = cloned[row.item.mi].content[row.item.pi];
    // Normalize Anthropic image blocks into the OpenAI-style reference form
    // understood by the Z.AI web payload.
    cloned[row.item.mi].content[row.item.pi] = {
      type: "image_url",
      image_url: { url: row.file.id }
    };
    void part;
  }

  return {
    messages: cloned,
    files: uploaded.map((x) => x.entry),
    imageParts: uploaded.map((x) => ({ type: "image_url", image_url: { url: x.file.id } })),
    imageCount: uploaded.length
  };
}

export function attachZaiImageParts(messages, imageParts) {
  const parts = Array.isArray(imageParts) ? imageParts : [];
  const out = JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : []));
  if (!parts.length || !out.length)
    return out;
  let target = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && out[i].role === "user") {
      target = i;
      break;
    }
  }
  if (target < 0)
    target = out.length - 1;
  const msg = out[target] || { role: "user", content: "" };
  const current = msg.content;
  if (Array.isArray(current))
    msg.content = current.concat(parts);
  else if (typeof current === "string" && current)
    msg.content = [{ type: "text", text: current }, ...parts];
  else
    msg.content = parts.slice();
  out[target] = msg;
  return out;
}

export const __visionTest = {
  isPrivateV4,
  isPrivateV6,
  isPublicAddress,
  imageUrlFromPart,
  parseDataUrl,
  safeFilename,
  fileEntry
};
