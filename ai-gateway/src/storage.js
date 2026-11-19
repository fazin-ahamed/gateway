// Optional object-storage backend: archives the gateway's data to an
// S3-compatible bucket (Backblaze B2, or any S3 API). Off by default; when
// enabled it snapshots the SQLite database and exports the taste data on an
// interval, so a reclaimed or lost host does not take the measurements with it.
//
// This is a backup path, not the live store: the gateway still reads and
// writes SQLite locally. Nothing is blocked or rerouted if the bucket is
// down; a failed upload is logged and retried on the next interval.
//
// AWS Signature Version 4 is implemented here in pure Node (crypto only), so
// the gateway keeps its single `hono` dependency. Tested against the
// Backblaze B2 S3 endpoint shape (https://s3.<region>.backblazeb2.com).

import { createHmac, createHash } from "node:crypto";

function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}
function isoBasic(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Sign and send one request. Minimal SigV4: enough for PUT/GET/HEAD/DELETE on
// a path-style or virtual-hosted bucket.
async function s3Request(cfg, method, key, body, contentType) {
  const host = cfg.endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const usePathStyle = cfg.pathStyle !== false; // Backblaze and most S3-compat want path style
  const canonicalUri = usePathStyle ? `/${cfg.bucket}/${key}` : `/${key}`;
  const canonicalHost = usePathStyle ? host : `${cfg.bucket}.${host}`;
  const url = (cfg.endpoint.startsWith("http") ? cfg.endpoint : "https://" + cfg.endpoint) + canonicalUri;

  const now = new Date();
  const amzDate = isoBasic(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || "");
  const headers = {
    "content-type": contentType || "application/octet-stream",
    host: canonicalHost,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => h + ":" + headers[h] + "\n").join("");
  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaderNames.join(";"), payloadHash].join("\n");
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac("AWS4" + cfg.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`;

  const res = await fetch(url, { method, headers, body: method === "PUT" ? body : undefined });
  return res;
}

export function storageConfigured(env) {
  const e = env || {};
  const ep = e.S3_ENDPOINT || "";
  const bucket = e.S3_BUCKET || "";
  const id = e.S3_ACCESS_KEY_ID || "";
  const secret = e.S3_SECRET_ACCESS_KEY || "";
  if (!ep || !bucket || !id || !secret) return null;
  return {
    endpoint: ep,
    bucket,
    accessKeyId: id,
    secretAccessKey: secret,
    region: e.S3_REGION || "us-west-004",
    pathStyle: e.S3_PATH_STYLE !== "0",
    prefix: (e.S3_PREFIX || "gateway/").replace(/\/+$/, "") + "/"
  };
}

// A connectivity probe: HEAD the bucket root object. Returns {ok, status, detail}.
export async function storageTest(cfg) {
  try {
    const res = await s3Request(cfg, "HEAD", cfg.prefix + ".probe", "");
    return { ok: res.status === 404 || res.status === 200 || res.status === 403, status: res.status, detail: res.status === 404 ? "bucket reachable" : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e && e.message || e) };
  }
}

export async function storagePut(cfg, key, body, contentType) {
  const res = await s3Request(cfg, "PUT", cfg.prefix + key, body, contentType);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, detail: text.slice(0, 200) };
  }
  return { ok: true, status: res.status };
}

// Upload a Buffer/string under a dated key. Returns the stored key on success.
export async function storageArchive(cfg, name, body, contentType) {
  const stamp = new Date().toISOString().slice(0, 10);
  const key = `${name.replace(/\/+$/, "")}/${stamp}/${new Date().toISOString().replace(/[:.]/g, "-")}.gz`;
  const r = await storagePut(cfg, key, body, contentType || "application/gzip");
  return r.ok ? { ok: true, key: cfg.prefix + key } : r;
}
