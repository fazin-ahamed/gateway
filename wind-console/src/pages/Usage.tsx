import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtInt, fmtMs, fmtUsd, fmtCountdown } from "../lib/api";
import { Card, Segmented, Skeleton } from "../lib/ui";

export function Usage() {
  const [days, setDays] = useState<"7" | "30" | "90">("7");
  const usage = useQuery({ queryKey: ["usage", days], queryFn: () => api.usage(Number(days)) });
  const limits = useQuery({ queryKey: ["limits"], queryFn: api.limits });
  const rolling = limits.data?.rolling;
  const models = usage.data?.models || [];
  const totalRequests = models.reduce((s, m) => s + m.requests, 0);
  const totalSpend = models.reduce((s, m) => s + m.spend_usd, 0);
  const totalTokens = models.reduce((s, m) => s + m.tokens, 0);

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Usage</h1>
          <p className="mt-1 text-sm text-muted">Recorded usage by model and window.</p>
        </div>
        <Segmented ariaLabel="Window" value={days} onChange={setDays} options={[{ value: "7", label: "7d" }, { value: "30", label: "30d" }, { value: "90", label: "90d" }]} />
      </div>

      {rolling && rolling.windows.some((w) => w.limit_usd != null || w.spent_usd > 0) && (
        <Card className="mt-6 p-6">
          <h2 className="text-[15px] font-semibold">Rolling windows</h2>
          <p className="text-sm text-muted">Spend is counted over the trailing 24 hours and 30 days. Nothing resets at midnight; each charge ages out on its own.</p>
          <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
            {rolling.windows.map((w) => (
              <div key={w.id} className="flex items-baseline justify-between rounded-2xl bg-default px-4 py-3">
                <div>
                  <div className="text-sm text-muted">{w.label}</div>
                  <div className="font-mono text-lg font-semibold tabular-nums">{fmtUsd(w.spent_usd)} spent</div>
                </div>
                <div className="text-sm text-muted">
                  {w.limit_usd != null ? `${fmtUsd(w.remaining_usd)} left` : "no cap"}
                  {w.resets_in_s != null && <span className="block text-xs">frees in {fmtCountdown(w.resets_in_s)}</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Card className="p-4"><div className="text-sm text-muted">Requests</div><div className="mt-0.5 font-mono text-2xl font-semibold tabular-nums">{fmtInt(totalRequests)}</div></Card>
        <Card className="p-4"><div className="text-sm text-muted">Tokens</div><div className="mt-0.5 font-mono text-2xl font-semibold tabular-nums">{fmtInt(totalTokens)}</div></Card>
        <Card className="p-4"><div className="text-sm text-muted">Spend</div><div className="mt-0.5 font-mono text-2xl font-semibold tabular-nums">{fmtUsd(totalSpend)}</div></Card>
      </div>

      <div className="mt-4 overflow-x-auto rounded-[20px] bg-surface shadow-[var(--surface-shadow)]">
        {usage.isLoading ? (
          <div className="flex flex-col gap-2 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} />)}</div>
        ) : models.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted">No model usage in this window.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 text-xs text-muted">
                <th className="rounded-tl-[20px] px-4 py-2.5 text-start font-medium">Model</th>
                <th className="px-4 py-2.5 text-start font-medium">Kind</th>
                <th className="px-4 py-2.5 text-end font-medium">Requests</th>
                <th className="px-4 py-2.5 text-end font-medium">Success</th>
                <th className="px-4 py-2.5 text-end font-medium">Tokens</th>
                <th className="px-4 py-2.5 text-end font-medium">p95 first token</th>
                <th className="rounded-tr-[20px] px-4 py-2.5 text-end font-medium">Spend</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.slug + m.model_kind} className="border-b border-separator last:border-0">
                  <td className="px-4 py-3">{m.slug}</td>
                  <td className="px-4 py-3 text-muted">{m.model_kind}</td>
                  <td className="px-4 py-3 text-end font-mono tabular-nums">{fmtInt(m.requests)}</td>
                  <td className="px-4 py-3 text-end font-mono tabular-nums">{m.requests ? Math.round((m.ok / m.requests) * 100) + "%" : "-"}</td>
                  <td className="px-4 py-3 text-end font-mono tabular-nums">{fmtInt(m.tokens)}</td>
                  <td className="px-4 py-3 text-end font-mono tabular-nums">{fmtMs(m.p95_ttft_ms)}</td>
                  <td className="px-4 py-3 text-end font-mono tabular-nums">{fmtUsd(m.spend_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
