// Programmatic CAPTCHA minting for chat.z.ai.
//
// The wire primitives are adapted from GLM-Free-API (MIT; see
// THIRD_PARTY_NOTICES.md), with the gateway's live-verified RPC encoding and
// explicit operator-supplied Aliyun credentials retained.
//
// Status (measured against live Aliyun + chat.z.ai):
//   ✓ Aliyun InitCaptchaV3 works with the same RFC3986-style RPC signing
//     used by the reference implementation.
//   ✓ The payload primitives are byte-identical to the published Go reference:
//     generateArg, the tracking JSON, and aliHash all match exactly.
//   ✓ Stealth-harvested device tokens can produce VerifyCode T001 and a real
//     securityToken.
//   ✓ The pure-HTTP transport now uses the reference completion lifecycle;
//     browser automation is a fallback rather than the primary serving path.
//
// Background: chat.z.ai gates completions behind an Aliyun "FeiLin" captcha.
// The proof is a base64 blob carrying a security token, minted by
// initialising a captcha, building the tracking payload the web client
// builds, verifying it against Aliyun with a device token, then handing the
// security token to chat.z.ai. Device tokens come from the page's Aliyun
// device SDK (`window.z_um.getToken()`), harvested in bulk.

import { createHmac, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { zaiWaf } from "./zai-waf.js";

// The Aliyun captcha credentials are NOT shipped here. Any deployment that
// wants to try minting must supply its own pair; see .env.example. The
// reference project hardcodes a shared pair, which is exactly the dependency
// that makes its approach fragile and that this repo will not carry.
const CAPTCHA_ACCESS_KEY = process.env.ZAI_CAPTCHA_ACCESS_KEY || "";
const CAPTCHA_SECRET_KEY = process.env.ZAI_CAPTCHA_SECRET_KEY || "";
const CAPTCHA_SCENE_ID = process.env.ZAI_CAPTCHA_SCENE_ID || "didk33e0";
const CAPTCHA_INIT_URL = "https://no8xfe.captcha-open-southeast.aliyuncs.com/";
const CAPTCHA_VERIFY_URL = "https://no8xfe-verify.captcha-open-southeast.aliyuncs.com/";

export function zaiCaptchaConfigured() {
  return !!(CAPTCHA_ACCESS_KEY && CAPTCHA_SECRET_KEY);
}

// ---------- RC4-like stream generator ----------
// Two different keys drive the same table walk: one for the tracking payload
// argument, one for the encrypted blob itself.
const PERM_TABLE = [
  32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30,
  60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49,
  18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40,
  8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21
];
const ARG_KEY = "4xrihv8zb8tf1mfj";
const PAYLOAD_KEY = "3e627e1b4c63f913";

function rc4Like(input, key) {
  const r = PERM_TABLE.slice();
  let j = 0;
  for (let i = 0; i < 64; i++) {
    j = (((i + j + r[i] + r[j]) >> 1) + key.charCodeAt(i % key.length)) & 63;
    if (i !== j) {
      const t = r[i];
      r[i] = r[j];
      r[j] = t;
    }
  }
  const out = Buffer.alloc(input.length);
  let e = 0;
  let a = 0;
  for (let idx = 0; idx < input.length; idx++) {
    a = ((e ^ a) + (r[e] ^ r[a])) & 63;
    if (e !== a) {
      const t = r[e];
      r[e] = r[a];
      r[a] = t;
    }
    let m = input[idx];
    m = m + e + r[e] - a - r[a];
    m = m ^ (r[e] + r[a]);
    m = m ^ r[(r[e] + r[a]) & 63];
    // The reference keeps only the low byte here (Go casts to uint8); the
    // encrypt variant uses `& 255` instead. They are not interchangeable.
    out[idx] = m & 255;
    e = (e + 1) & 63;
  }
  return out;
}

export const generateArg = (certifyId) => rc4Like(Buffer.from(certifyId, "utf8"), ARG_KEY).toString("base64");
export const encryptPayload = (bytes) => rc4Like(bytes, PAYLOAD_KEY).toString("base64");

// ---------- aliHash: 16-byte state digest over the tracking payload ----------
export function aliHash(input, salt) {
  const o = Buffer.from(input, "utf8");
  const r = Buffer.from(salt, "utf8");
  const e = new Array(16);
  for (let i = 0; i < 16; i++)
    e[i] = (i << 4) + (i % 16);
  let j = 0;
  for (let i = 0; i < 16; i++) {
    j = (((i + j + e[i] + e[j]) >> 1) + r[i % r.length]) & 15;
    const t = e[i];
    e[i] = e[j];
    e[j] = t;
  }
  let p = 0;
  let q = 0;
  for (let idx = 0; idx < o.length; idx++) {
    q = ((p ^ q) + (e[p] ^ e[q])) & 15;
    const t = e[p];
    e[p] = e[q];
    e[q] = t;
    let c = o[idx];
    c = (c + p + q) ^ e[p] ^ e[q];
    c &= 255;
    e[p] = c;
    p = (p + 1) & 15;
  }
  for (let step = 0; step < 32; step++) {
    const pos = step % 16;
    if (pos !== 0)
      e[pos] ^= e[pos - 1];
    else
      e[0] ^= e[15];
  }
  let out = "";
  for (const b of e)
    out += b.toString(16).padStart(2, "0");
  return out;
}

// Builds the tracking payload exactly as the web client does. Every TrackList
// field is present: Aliyun hashes and encrypts this JSON byte-for-byte, and a
// struct marshalled from Go emits all nine keys (eight empty strings) in this
// order. Omitting them changes the bytes and Aliyun answers F001.
export function buildTrackPayload(certifyId, startTime) {
  const track = {
    TrackList: {
      fi: "",
      ks: "",
      mc: "",
      mp: "",
      mu: "",
      startTime,
      tc: "",
      te: "",
      tmv: ""
    },
    TrackStartTime: startTime,
    VerifyTime: startTime + 300,
    arg: generateArg(certifyId)
  };
  const json = JSON.stringify(track);
  const digest = aliHash(json, "0000");
  const compressed = deflateSync(Buffer.from(digest + json, "utf8"));
  return encryptPayload(Buffer.from(compressed.toString("base64"), "utf8"));
}

// ---------- Aliyun RPC ----------
// Same RFC3986-style Aliyun encoding as GLM-Free-API: alnum and -_.~ stay
// literal; all other bytes are percent-encoded before canonical signing.
function pct(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function rpcBody(params) {
  const canonical = Object.keys(params).sort().map((k) => pct(k) + "=" + pct(params[k])).join("&");
  const stringToSign = "POST&" + pct("/") + "&" + pct(canonical);
  const all = { ...params, Signature: createHmac("sha1", CAPTCHA_SECRET_KEY + "&").update(stringToSign).digest("base64") };
  return Object.keys(all).sort().map((k) => pct(k) + "=" + pct(all[k])).join("&");
}
function baseParams(action) {
  return {
    AccessKeyId: CAPTCHA_ACCESS_KEY,
    Action: action,
    Format: "JSON",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2023-03-05"
  };
}
async function aliyun(url, params, fetchImpl) {
  // Aliyun captcha RPCs share the same egress pacing lane as chat.z.ai POSTs.
  // callZaiMinted checks the WAF breaker before consuming its single-use token.
  await zaiWaf.pace();
  const res = await (fetchImpl || fetch)(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: rpcBody(params)
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { parse_error: true, status: res.status, body: text.slice(0, 200) };
  }
}

/**
 * Mint one captcha_verify_param using a harvested device token.
 * Returns the base64 blob chat.z.ai accepts as `captcha_verify_param`, or null
 * with a reason (the caller decides whether to try another token).
 */
export async function mintCaptcha(deviceToken, options = {}) {
  const fetchImpl = options.fetchImpl;
  if (!zaiCaptchaConfigured())
    return { ok: false, reason: "captcha-config", detail: "Aliyun captcha credentials are not configured" };
  if (!deviceToken)
    return { ok: false, reason: "no-device-token" };
  const init = await aliyun(CAPTCHA_INIT_URL, {
    ...baseParams("InitCaptchaV3"),
    Language: "en",
    Mode: "popup",
    SceneId: CAPTCHA_SCENE_ID,
    UpLang: "true"
  }, fetchImpl);
  const certifyId = init && init.CertifyId;
  if (!certifyId)
    return { ok: false, reason: "init-failed", detail: JSON.stringify(init).slice(0, 200) };

  const data = buildTrackPayload(certifyId, Date.now());
  const cvp = JSON.stringify({ certifyId, data, deviceToken, sceneId: CAPTCHA_SCENE_ID });
  const verify = await aliyun(CAPTCHA_VERIFY_URL, {
    ...baseParams("VerifyCaptchaV3"),
    SceneId: CAPTCHA_SCENE_ID,
    CertifyId: certifyId,
    CaptchaVerifyParam: cvp
  }, fetchImpl);
  const result = verify && verify.Result;
  if (!verify || verify.Success !== true || !result || result.VerifyResult !== true)
    return { ok: false, reason: "verify-failed", detail: JSON.stringify(verify).slice(0, 200) };

  const payload = Buffer.from(JSON.stringify({
    certifyId: result.certifyId,
    isSign: true,
    sceneId: CAPTCHA_SCENE_ID,
    securityToken: result.securityToken
  }), "utf8").toString("base64");
  return { ok: true, param: payload };
}

export const __captchaTest = { rc4Like, aliHash, generateArg, encryptPayload, buildTrackPayload, rpcBody, PERM_TABLE, ARG_KEY, PAYLOAD_KEY, CAPTCHA_SCENE_ID, zaiCaptchaConfigured };
