// Bayesian route/model posteriors with exponential time decay.
//
// Never treat 0/2 as 100%. A new route starts at Beta(8,2) ≈ 80%. Two
// failures move it to Beta(8,4) ≈ 67%, not "unknown therefore healthy".
// Routing uses the lower confidence bound so 2/2 cannot beat 997/1000.

const LN2 = Math.LN2;

export function seedBeta(kind = "route") {
  if (kind === "model") return { alpha: 6, beta: 2 };
  if (kind === "tool") return { alpha: 4, beta: 2 };
  return { alpha: 8, beta: 2 };
}

export function decayMass(mass, elapsedMs, halfLifeMs) {
  const m = Number(mass) || 0;
  const hl = Number(halfLifeMs) || 0;
  if (m <= 0 || hl <= 0) return Math.max(0, m);
  const dt = Math.max(0, Number(elapsedMs) || 0);
  return m * Math.exp(-dt * LN2 / hl);
}

export function age(state, at = Date.now(), halfLifeMs = 3 * 86400000, kind = "route") {
  const prev = state || {};
  const useKind = prev.kind || kind;
  const prior = seedBeta(useKind);
  const last = Number.isFinite(Number(prev.updatedAt)) ? Number(prev.updatedAt) : at;
  const elapsed = Math.max(0, at - last);
  // Sign-preserving decay: the excess over the prior fades toward the prior in
  // BOTH directions. Clamping a negative excess to zero snapped a route that
  // had learned "worse than prior" (alpha below the prior) back up to the
  // prior while beta kept its mass — erasing the learned signal at read time.
  // Decay the magnitude, keep the sign, so stale evidence reverts symmetrically.
  const toward = (p, v) => {
    const excess = Number(v ?? p) - p;
    return p + Math.sign(excess) * decayMass(Math.abs(excess), elapsed, halfLifeMs);
  };
  return {
    kind: useKind,
    alpha: toward(prior.alpha, prev.alpha),
    beta: toward(prior.beta, prev.beta),
    updatedAt: at
  };
}

export function observe(state, success, at = Date.now(), halfLifeMs = 3 * 86400000, kind = "route") {
  const aged = age(state, at, halfLifeMs, kind);
  return {
    kind: aged.kind,
    alpha: aged.alpha + (success ? 1 : 0),
    beta: aged.beta + (success ? 0 : 1),
    updatedAt: at
  };
}

export function mean(state) {
  const a = Number(state && state.alpha) || 0;
  const b = Number(state && state.beta) || 0;
  if (a + b <= 0) return 0.8;
  return a / (a + b);
}

// Wilson-ish conservative bound from Beta parameters. z=1.28 ≈ 90% one-sided.
export function lcb(state, z = 1.28) {
  const a = Math.max(1e-6, Number(state && state.alpha) || 0);
  const b = Math.max(1e-6, Number(state && state.beta) || 0);
  const n = a + b;
  const p = a / n;
  const bound = p - z * Math.sqrt(p * (1 - p) / n);
  return Math.max(0, Math.min(1, bound));
}

export function samples(state) {
  const a = Number(state && state.alpha) || 0;
  const b = Number(state && state.beta) || 0;
  const seed = seedBeta(state && state.kind || "route");
  return Math.max(0, a + b - seed.alpha - seed.beta);
}

export function summarize(state) {
  return {
    mean: mean(state),
    lcb: lcb(state),
    samples: Math.round(samples(state)),
    alpha: Number(state && state.alpha) || 0,
    beta: Number(state && state.beta) || 0
  };
}
