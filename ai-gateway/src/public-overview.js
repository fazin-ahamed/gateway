const snapshots = new WeakMap();
const SNAPSHOT_MS = 30_000;
const DAY_MS = 86_400_000;

function publicModel(model) {
  const kind = model.model_kind === "decision" ? "decision" : "chat";
  const capabilities = {};
  const names = kind === "decision" ? ["choice", "score", "noul"] : ["streaming", "tools", "vision", "reasoning"];
  for (const name of names) capabilities[name] = !!model.capabilities?.[name];
  return {
    id: String(model.id),
    model_kind: kind,
    endpoint: kind === "decision" ? "/v1/systemone" : "/v1/chat/completions",
    context_window: kind === "chat" && Number.isFinite(model.context_window) ? model.context_window : null,
    max_output_tokens: kind === "chat" && Number.isFinite(model.max_output_tokens) ? model.max_output_tokens : null,
    capabilities
  };
}

async function buildOverview(db, getModels) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(today - 6 * DAY_MS).toISOString();
  const end = new Date(today + DAY_MS).toISOString();
  const [totals, days, models] = await Promise.all([
    db.prepare("SELECT COUNT(*) requests, COALESCE(SUM(prompt_tokens),0) input_tokens, COALESCE(SUM(completion_tokens),0) output_tokens, COALESCE(SUM(total_tokens),0) total_tokens, MIN(created_at) first_recorded_at, MAX(created_at) last_request_at FROM request_summaries").first(),
    db.prepare("SELECT substr(created_at,1,10) day, COUNT(*) requests, COALESCE(SUM(total_tokens),0) total_tokens FROM request_summaries WHERE created_at>=? AND created_at<? GROUP BY substr(created_at,1,10) ORDER BY day").bind(start, end).all(),
    getModels()
  ]);
  const byDay = new Map((days.results || []).map((row) => [row.day, row]));
  const points = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(today - (6 - i) * DAY_MS).toISOString().slice(0, 10);
    const row = byDay.get(date);
    points.push({ date, requests: Number(row?.requests) || 0, total_tokens: Number(row?.total_tokens) || 0 });
  }
  return {
    generated_at: now.toISOString(),
    service: {
      name: "Astrosphere",
      protocol: "OpenAI-compatible",
      api_base_path: "/v1",
      chat_endpoint: "/v1/chat/completions",
      decision_endpoint: "/v1/systemone"
    },
    usage: {
      requests: Number(totals.requests),
      input_tokens: Number(totals.input_tokens),
      output_tokens: Number(totals.output_tokens),
      total_tokens: Number(totals.total_tokens),
      first_recorded_at: totals.first_recorded_at || null,
      last_request_at: totals.last_request_at || null
    },
    activity: { window_days: 7, points },
    models: models.map(publicModel)
  };
}

export function loadPublicOverview(db, getModels) {
  const cached = snapshots.get(db);
  if (cached?.pending) return cached.pending;
  if (cached?.value && cached.expires > Date.now()) return Promise.resolve(cached.value);
  const entry = {};
  entry.pending = buildOverview(db, getModels).then((value) => {
    entry.value = value;
    entry.expires = Date.now() + SNAPSHOT_MS;
    entry.pending = null;
    return value;
  }).catch((error) => {
    snapshots.delete(db);
    throw error;
  });
  snapshots.set(db, entry);
  return entry.pending;
}
