// What Auto can honestly claim, computed from the routes a caller can actually
// use right now. Pure: no database, no catalog fetch. The router and
// /v1/models both consume it, so they cannot disagree about a capability.
//
// A known catalog entry with no context window is not unlimited. It gets the
// same conservative ceiling V2 uses, because "we have a row but no number" is
// not evidence the model accepts an arbitrary prompt.
//
// Resilience counts distinct providers, not routes. Two routes on one upstream
// fail together, so they are one failure domain.

export const UNKNOWN_CONTEXT_CEILING = 32000;

export function contextLimit(caps) {
  if (!caps || caps.unknown)
    return UNKNOWN_CONTEXT_CEILING;
  const ctx = Number(caps.context) || 0;
  return ctx > 0 ? ctx : UNKNOWN_CONTEXT_CEILING;
}

// routes: { providerId, context, output, tools, vision, reasoning, circuitOpen }
// A route with its circuit open is unusable and never counted.
export function buildCapabilityEnvelope(routes, { minIndependentProviders = 2 } = {}) {
  const live = (routes || []).filter((r) => r && !r.circuitOpen);
  const providers = new Set(live.map((r) => r.providerId));
  const maxOf = (pick) => live.reduce((m, r) => Math.max(m, pick(r)), 0);
  const resilientOf = (pick) => {
    const byProvider = new Map();
    for (const r of live) {
      const value = pick(r);
      const prev = byProvider.get(r.providerId) || 0;
      if (value > prev)
        byProvider.set(r.providerId, value);
    }
    const values = [...byProvider.values()].sort((a, b) => b - a);
    return values.length >= minIndependentProviders ? values[minIndependentProviders - 1] : 0;
  };
  const any = (flag) => live.some((r) => r[flag]);
  const resilientFlag = (flag) => {
    const who = new Set(live.filter((r) => r[flag]).map((r) => r.providerId));
    return who.size >= minIndependentProviders;
  };

  const maxContext = maxOf((r) => contextLimit(r));
  const resilientContext = resilientOf((r) => contextLimit(r));
  return {
    context_window: resilientContext || maxContext,
    max_output_tokens: maxOf((r) => Number(r.output) || 0),
    capabilities: {
      streaming: live.length > 0,
      tools: any("tools"),
      vision: any("vision"),
      reasoning: any("reasoning")
    },
    routing: {
      dynamic: true,
      max_context: maxContext,
      resilient_context: resilientContext,
      max_output: maxOf((r) => Number(r.output) || 0),
      eligible_routes: live.length,
      independent_providers: providers.size,
      resilient: {
        tools: resilientFlag("tools"),
        vision: resilientFlag("vision"),
        reasoning: resilientFlag("reasoning")
      }
    }
  };
}

export function autoModelEntry(envelope) {
  return {
    id: "auto",
    object: "model",
    created: 0,
    owned_by: "gateway",
    context_window: envelope.context_window,
    max_output_tokens: envelope.max_output_tokens,
    capabilities: envelope.capabilities,
    routing: envelope.routing
  };
}
