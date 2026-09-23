// Latency governor, shadow only.
//
// Answers three questions about an auto request and launches nothing:
//   how long would the primary be given,
//   which route would be started if that elapsed,
//   did the request actually outlast it.
//
// The deadline is a multiple of an observed first-token baseline, clamped.
// With no history it falls back to a static default, so a brand new route is
// not declared late after a few hundred milliseconds. The baseline is TTFT,
// never total latency: a slow completion that started quickly is not late.
//
// A backup must be able to serve the request and must come from a different
// provider when one exists. Same-provider routes fail together.

export const CONTEXT_BUCKETS = [
  [8192, "lt8k"],
  [32768, "8k-32k"],
  [131072, "32k-128k"],
  [524288, "128k-512k"],
  [Infinity, "512k+"]
];

export const DEFAULT_BASELINE_MS = 4000;
export const DEADLINE_MIN_MS = 1500;
export const DEADLINE_MAX_MS = 60000;

const MULTIPLIER = {
  chat: 2.0,
  code: 2.2,
  agent: 2.5
};

export function contextBucket(tokens) {
  const n = Math.max(0, Number(tokens) || 0);
  for (const [ceiling, name] of CONTEXT_BUCKETS)
    if (n < ceiling)
      return name;
  return "512k+";
}

function multiplierFor(taskType) {
  const head = String(taskType || "").split(":")[0];
  if (head === "code")
    return MULTIPLIER.code;
  if (head === "agent" || head === "tool")
    return MULTIPLIER.agent;
  return MULTIPLIER.chat;
}

// samples: [{ key, ttftMs, n }]. The first key with enough samples wins, so
// the caller passes them most specific first.
export function deadlineFor({ taskType, samples, minSamples = 8 }) {
  let baseline = null;
  let source = "default";
  let count = 0;
  for (const s of samples || []) {
    if (s && Number(s.n) >= minSamples && Number(s.ttftMs) > 0) {
      baseline = Number(s.ttftMs);
      source = s.key;
      count = Number(s.n);
      break;
    }
  }
  if (baseline == null)
    baseline = DEFAULT_BASELINE_MS;
  const raw = baseline * multiplierFor(taskType);
  const deadline = Math.round(Math.min(DEADLINE_MAX_MS, Math.max(DEADLINE_MIN_MS, raw)));
  return { deadlineMs: deadline, baselineMs: baseline, samples: count, source };
}

// candidates: { routeId, providerId, slug, eligible, quality, expectedTtftMs }
// The primary is excluded. A different provider wins over a faster same
// provider route, and a candidate more than qualityMargin below the primary
// is rejected outright.
export function chooseBackup(primary, candidates, { qualityMargin = 0.5 } = {}) {
  const pool = (candidates || []).filter((c) =>
    c && c.routeId !== primary.routeId && c.eligible &&
    Number(c.quality) >= Number(primary.quality) - qualityMargin
  );
  if (!pool.length)
    return null;
  const independent = pool.filter((c) => c.providerId !== primary.providerId);
  const choice = (independent.length ? independent : pool)
    .slice()
    .sort((a, b) => (Number(a.expectedTtftMs) || Infinity) - (Number(b.expectedTtftMs) || Infinity))[0];
  return choice || null;
}

// A request only counts as late if it outlasted the deadline without a
// semantic token. A client cancel is the caller's decision, not the route's.
export function wouldHedge({ deadlineMs, ttftMs, finishedMs, cancelled }) {
  if (cancelled)
    return false;
  if (ttftMs != null)
    return Number(ttftMs) > deadlineMs;
  return finishedMs != null && Number(finishedMs) > deadlineMs;
}
