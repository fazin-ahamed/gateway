import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtInt, type Model } from "../lib/api";
import { Chip, Input, Segmented } from "../lib/ui";

function price(m: Model): string {
  const one = (v: number | null | undefined) => (v == null ? "-" : `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`);
  if (m.per_request != null) return `${one(m.per_request)} per request`;
  if (m.prompt_per_1m != null || m.completion_per_1m != null) return `${one(m.prompt_per_1m)} in, ${one(m.completion_per_1m)} out per 1M`;
  return "unpriced";
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "chat", label: "Chat" },
  { value: "decision", label: "Decision" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "reasoning", label: "Reasoning" },
  { value: "tools", label: "Tools" }
] as const;
type Filter = (typeof FILTERS)[number]["value"];

export function Models() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const models = useQuery({ queryKey: ["models"], queryFn: api.models });
  const all = models.data?.data || [];
  const shown = all.filter((m) => {
    if (q && !(m.id + " " + (m.name || "")).toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === "all") return true;
    if (filter === "reasoning") return !!m.reasoning;
    if (filter === "tools") return !!m.tools;
    if (filter === "chat") return m.model_kind === "chat";
    if (filter === "decision") return m.model_kind === "decision";
    return (m.kinds || []).includes(filter);
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Models</h1>
          <p className="mt-1 text-sm text-muted">What this gateway can serve to your keys right now.</p>
        </div>
        <div className="w-full max-w-xs">
          <Input placeholder="Filter models" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter models" />
        </div>
      </div>
      <div className="mt-5 overflow-x-auto pb-1">
        <Segmented ariaLabel="Model kind" value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
      </div>

      {shown.length === 0 ? (
        <div className="mt-6 rounded-[20px] bg-surface p-10 text-center text-sm text-muted shadow-[var(--surface-shadow)]">
          {models.isLoading ? "Reading the catalogue..." : models.isError ? "The catalogue could not load." : "No models match."}
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((m) => (
            <div key={m.id + m.model_kind} className="flex flex-col gap-3 rounded-[24px] bg-surface p-5 shadow-[var(--surface-shadow)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm font-medium">{m.id}</div>
                  {m.name && m.name !== m.id && <div className="truncate text-xs text-muted">{m.name}</div>}
                </div>
                {m.uptime != null && m.samples ? (
                  <Chip variant={m.uptime >= 0.99 ? "success" : m.uptime >= 0.9 ? "warning" : "danger"}>{Math.round(m.uptime * 100)}%</Chip>
                ) : (
                  <Chip>no recent requests</Chip>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Chip variant="accent">{m.model_kind}</Chip>
                {(m.kinds || []).filter((k) => k !== "chat" && k !== m.model_kind).map((k) => <Chip key={k} variant="accent">{k}</Chip>)}
                {m.reasoning && <Chip>reasoning</Chip>}
                {m.tools && <Chip>tools</Chip>}
                {m.vision && <Chip>vision</Chip>}
              </div>
              <div className="mt-auto grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
                {m.context_window != null && <span>context <span className="font-mono text-foreground">{fmtInt(m.context_window)}</span></span>}
                {m.max_output_tokens != null && <span>max out <span className="font-mono text-foreground">{fmtInt(m.max_output_tokens)}</span></span>}
                {m.knowledge && <span className="col-span-2">knowledge {m.knowledge}</span>}
                <span className="col-span-2 font-mono text-foreground">{price(m)}{m.price_source === "models.dev" ? ", via models.dev" : ""}</span>
                {m.endpoint && <span className="col-span-2 font-mono text-[11px]">{m.endpoint}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
