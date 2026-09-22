// Screenshot metrics — compare two rendered images without a model.
//
// The UI verifier captures a viewport per width; this module turns a pair of
// PNG byte buffers into a deterministic similarity score so a ui-repair can
// answer "did the fix change what the user sees?" with a number instead of
// an eyeball call.
//
// What it reports:
//   - dimensionMatch: same width and height
//   - meanAbsoluteDifference: mean per-channel delta, 0-255
//   - edgeDensityDifference: |edges(a) - edges(b)| as a fraction of pixels
//   - phashDistance: Hamming distance between 8x8 perceptual hashes
//   - visualSimilarity: 0.00-1.00, normalized blend of the above
//
// No external dependencies. PNG decoding is the minimal chunk-walking
// inflater needed for screenshots: zlib handles the DEFLATE stream, and only
// IHDR/IDAT/IEND chunks are read. It is deliberately not a general PNG
// decoder — it supports the 8-bit truecolor with alpha that Chromium emits.

import { gunzipSync, inflateSync } from "node:zlib";

export function describeImage(buffer) {
  const png = decodePng(buffer);
  if (!png)
    return null;
  const { width, height, rgba } = png;
  const pixels = width * height;

  // Sobel-ish edge density: a pixel is an edge when any neighbor channel
  // differs by more than the threshold. Counted on a downscaled grid so the
  // metric is not dominated by a high-DPI screenshot's noise.
  const edges = countEdges(rgba, width, height);
  const edgeDensity = edges / pixels;

  // 8x8 perceptual hash over luminance, DCT-free: average the image into 64
  // cells, threshold by the mean. Stable under compression and small shifts.
  const phash = phashOf(rgba, width, height);

  return { width, height, pixels, edgeDensity, phash };
}

export function compareImages(a, b) {
  const ma = describeImage(a);
  const mb = describeImage(b);
  if (!ma || !mb)
    return null;
  const dimensionMatch = ma.width === mb.width && ma.height === mb.height;

  let channelDiff = 0;
  if (dimensionMatch) {
    // Only comparable at equal size; otherwise the pixel diff is meaningless.
    const len = Math.min(ma.rgbaLength ?? 0, mb.rgbaLength ?? 0);
  }

  const mad = meanAbsoluteDifference(a, b);
  const edgeDensityDifference = Math.abs(ma.edgeDensity - mb.edgeDensity);
  const phashDistance = hamming(ma.phash, mb.phash);

  // Normalize each axis to 0-1 and blend. The weights are chosen so a
  // pixel-identical render is exactly 1.00 and a totally different layout
  // with the same dimensions still scores low, not zero.
  const madScore = 1 - Math.min(mad / 48, 1);
  const edgeScore = 1 - Math.min(edgeDensityDifference / 0.5, 1);
  const phashScore = 1 - phashDistance / 64;
  const dimScore = dimensionMatch ? 1 : 0;
  const visualSimilarity = Math.round(
    (0.4 * madScore + 0.2 * edgeScore + 0.3 * phashScore + 0.1 * dimScore) * 100
  ) / 100;

  return {
    dimensionMatch,
    width: { a: ma.width, b: mb.width },
    height: { a: ma.height, b: mb.height },
    meanAbsoluteDifference: mad,
    edgeDensityDifference,
    phashDistance,
    visualSimilarity
  };
}

function meanAbsoluteDifference(a, b) {
  const pa = decodePng(a);
  const pb = decodePng(b);
  if (!pa || !pb || pa.width !== pb.width || pa.height !== pb.height)
    return null;
  let sum = 0;
  const len = Math.min(pa.rgba.length, pb.rgba.length);
  for (let i = 0; i < len; i += 4) {
    sum += Math.abs(pa.rgba[i] - pb.rgba[i])
      + Math.abs(pa.rgba[i + 1] - pb.rgba[i + 1])
      + Math.abs(pa.rgba[i + 2] - pb.rgba[i + 2]);
  }
  const pixels = len / 4;
  return Math.round((sum / (pixels * 3)) * 100) / 100;
}

function countEdges(rgba, width, height) {
  let edges = 0;
  const stride = 4;
  for (let y = 0; y < height - 1; y += 2) {
    for (let x = 0; x < width - 1; x += 2) {
      const i = (y * width + x) * stride;
      const r = (y * width + x + 1) * stride;
      const d = (y + 1) * width + x;
      const c = d * stride;
      const diff = Math.abs(rgba[i] - rgba[r]) + Math.abs(rgba[i] - rgba[c])
        + Math.abs(rgba[i + 1] - rgba[r + 1]) + Math.abs(rgba[i + 1] - rgba[c + 1])
        + Math.abs(rgba[i + 2] - rgba[r + 2]) + Math.abs(rgba[i + 2] - rgba[c + 2]);
      if (diff > 90) edges++;
    }
  }
  return edges;
}

function luminanceAt(rgba, i) {
  // sRGB luminance, matching the contrast math in the verifier.
  return 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
}

function phashOf(rgba, width, height) {
  // 8x8 grid of mean luminance, thresholded by the overall mean.
  const cells = new Float64Array(64);
  const means = new Float64Array(64);
  const cw = width / 8;
  const ch = height / 8;
  let total = 0;
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      let sum = 0;
      let count = 0;
      const x0 = Math.floor(cx * cw);
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cw));
      const y0 = Math.floor(cy * ch);
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * ch));
      for (let y = y0; y < Math.min(y1, height); y++) {
        for (let x = x0; x < Math.min(x1, width); x++) {
          sum += luminanceAt(rgba, (y * width + x) * 4);
          count++;
        }
      }
      const m = count ? sum / count : 0;
      means[cy * 8 + cx] = m;
      total += m;
    }
  }
  const avg = total / 64;
  let bits = 0n;
  for (let i = 0; i < 64; i++) {
    if (means[i] > avg) bits |= 1n << BigInt(63 - i);
  }
  return bits.toString(16).padStart(16, "0");
}

function hamming(aHex, bHex) {
  let a = BigInt("0x" + aHex);
  let b = BigInt("0x" + bHex);
  let x = a ^ b;
  let distance = 0;
  while (x) {
    distance += Number(x & 1n);
    x >>= 1n;
  }
  return distance;
}

// Minimal PNG reader for the 8-bit truecolor + alpha screenshots Chromium
// produces. Walks the chunks, concatenates IDAT, inflates, and undoes the
// per-scanline filter. Returns null for anything it cannot handle so callers
// can skip metrics instead of crashing the audit.
function decodePng(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 33) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readUint32(bytes, offset + 8);
      height = readUint32(bytes, offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      interlace = bytes[offset + 20];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0)
    return null;
  const channels = colorType === 6 ? 4 : 3;
  if (width === 0 || height === 0) return null;

  const compressed = concat(idatChunks);
  let inflated;
  try {
    inflated = inflateSync(compressed);
  } catch {
    try {
      inflated = gunzipSync(compressed);
    } catch {
      return null;
    }
  }

  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const line = inflated.subarray(src, src + stride);
    src += stride;
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const raw = line[x];
      const left = x >= channels ? out[x - channels] : 0;
      const up = prev[x];
      const upLeft = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: out[x] = raw; break;
        case 1: out[x] = (raw + left) & 0xff; break;
        case 2: out[x] = (raw + up) & 0xff; break;
        case 3: out[x] = (raw + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          out[x] = (raw + pred) & 0xff;
          break;
        }
        default: return null;
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      rgba[d] = out[s];
      rgba[d + 1] = out[s + 1];
      rgba[d + 2] = out[s + 2];
      rgba[d + 3] = channels === 4 ? out[s + 3] : 255;
    }
    prev = out;
  }
  return { width, height, rgba, rgbaLength: rgba.length };
}

function readUint32(bytes, offset) {
  return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
