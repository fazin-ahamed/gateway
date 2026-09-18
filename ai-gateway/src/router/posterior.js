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
  if (m <= 0 || hl <= 0) return m;
  const dt = Math.max(0, Number(elapsedMs) || 0);
  return m * Math.exp(-dt * LN2 / hl);
}

export function observe(state, success, at = Date.now(), halfLifeMs = 3 * 86400000) {
  const prev = state || {};
  const last = Number(prev.updatedAt) || at;
  const elapsed = Math.max(0, at - last);
  const alpha = decayMass(prev.alpha ?? seedBeta().alpha, elapsed, halfLifeMs);
  const beta = decayMass(prev.beta ?? seedBeta().beta, elapsed, halfLifeMs);
  return {
    alpha: alpha + (success ? 1 : 0),
    beta: beta + (success ? 0 : 1),
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
  const seed = seedBeta();
  return Math.max(0, a + b - seed.alpha - seed.beta);
}

export function summarize(state) {
  return {
    mean: mean(state),
    lcb: lcb(state),
    samples: samples(state),
    alpha: Number(state && state.alpha) || 0,
    beta: Number(state && state.beta) || 0
  };
}
