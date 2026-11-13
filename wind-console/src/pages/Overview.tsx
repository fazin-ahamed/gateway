import { useQuery } from "@tanstack/react-query";
import { motion, useSpring, useTransform } from "framer-motion";
import { Link } from "react-router-dom";
import { api, fmtCountdown, fmtInt, fmtUsd, type Limits, type RollingWindow, type Taste } from "../lib/api";
import { Card, Segmented, Skeleton, useToast } from "../lib/ui";
import { useEffect, useState } from "react";

const EASE = [0.23, 1, 0.32, 1] as const;

function Money({ value, className }: { value: number; className?: string }) {
  const spring = useSpring(value, { bounce: 0, duration: 0.45 });
  const text = useTransform(spring, (v) => `$${v.toFixed(2)}`);
  useEffect(() => { spring.set(value); }, [value, spring]);
  return <motion.span className={className}>{text}</motion.span>;
}

function WindowBar({ w }: { w: RollingWindow }) {
  const capped = w.limit_usd != null && w.limit_usd > 0;
  const fill = capped && w.spent_usd > 0 ? Math.min(100, Math.max(2.2, (w.spent_usd / (w.limit_usd as number)) * 100)) : 0;
  const tick = w.resets_in_s != null ? Math.min(99, Math.max(1, (w.resets_in_s / (w.hours * 3600)) * 100)) : null;
  const full = capped && (w.remaining_usd ?? 0) <= 0;
  return (
    <div className="min-w-0">
      <div className="text-sm text-muted">{w.label}</div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5">
        {capped ? (
          <>
            <strong className={"font-mono text-[30px] font-semibold leading-9 tracking-tight tabular-nums " + (full ? "text-danger-soft-fg" : "")}>
              <Money value={w.remaining_usd ?? 0} />
            </strong>
            <span className="text-sm text-muted">left of <span className="font-mono tabular-nums">{fmtUsd(w.limit_usd)}</span></span>
          </>
        ) : (
          <>
            <strong className="font-mono text-[30px] font-semibold leading-9 tracking-tight">No cap</strong>
            <span className="text-sm text-muted"><span className="font-mono tabular-nums">{fmtUsd(w.spent_usd)}</span> spent</span>
          </>
        )}
      </div>
      <div
        className="relative mt-3.5 h-[26px] overflow-hidden rounded-[10px] bg-default"
        style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--track-hatch) 0 2px, transparent 2px 7px)" }}
        role="img"
        aria-label={capped ? `${fmtUsd(w.spent_usd)} of ${fmtUsd(w.limit_usd)} spent in the ${w.label.toLowerCase()}` : `${fmtUsd(w.spent_usd)} spent, no cap`}
      >
        <motion.div
          className={"absolute inset-y-0 left-0 rounded-[10px] " + (full ? "bg-danger" : "bg-accent")}
          initial={{ width: 0 }}
          animate={{ width: fill + "%" }}
          transition={{ duration: 0.4, ease: EASE }}
          style={{ minWidth: fill > 0 ? 8 : 0 }}
        />
        {tick != null && capped && <span className="absolute inset-y-0 w-0.5 -ml-px bg-foreground" style={{ left: tick + "%" }} />}
      </div>
      <div className="mt-2.5 flex flex-wrap justify-between gap-x-4 text-xs leading-[17px] text-muted">
        <span><span className="font-mono tabular-nums">{fmtUsd(w.spent_usd)}</span> spent in this window</span>
        {w.resets_in_s != null && (
          <span className="inline-flex items-center gap-1.5" title="The oldest spend in this window ages out at the mark on the bar">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" /></svg>
            frees up in <span className="font-mono tabular-nums">{fmtCountdown(w.resets_in_s)}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function BudgetCard({ limits }: { limits: Limits | undefined }) {
  const rolling = limits?.rolling;
  if (!limits) return <Skeleton className="h-[220px] rounded-[24px]" />;
  if (!rolling) {
    const b = limits.budget;
    const uncapped = !!(b.uncapped || b.limit <= 0 || b.limit >= 1e9);
    return (
      <Card className="p-7">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Budget left</h2>
          <Link to="/usage" className="rounded-full px-3.5 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-default hover:text-foreground">See usage</Link>
        </div>
        <div className="mt-2">
          <div className="text-sm text-muted">{b.mode === "usd" ? "Spend" : "Tokens"} used</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">{b.mode === "usd" ? fmtUsd(b.used) : fmtInt(b.used)}</div>
          <div className="mt-1 text-xs text-muted">
            {uncapped ? `No spend cap on this ${limits.budget_scope === "key" ? "key" : "account"}.` : `of ${b.mode === "usd" ? fmtUsd(b.limit) : fmtInt(b.limit)}, ${b.mode === "usd" ? fmtUsd(b.remaining ?? 0) : fmtInt(b.remaining ?? 0)} left`}
          </div>
        </div>
      </Card>
    );
  }
  const soonest = rolling.windows
    .filter((w) => w.limit_usd != null && (w.remaining_usd ?? 1) <= 0 && w.resets_in_s != null)
    .sort((a, b) => (a.resets_in_s as number) - (b.resets_in_s as number))[0];
  const short = (id: string) => (id === "24h" ? "24-hour" : "30-day");
  const fmtRate = (n: number) => `$${n.toFixed(2)}`;
  return (
    <Card className="overflow-hidden p-7">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Budget left</h2>
        <Link to="/usage" className="rounded-full px-3.5 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-default hover:text-foreground">See usage</Link>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-7 md:grid-cols-2 md:gap-14">
        {rolling.windows.map((w) => <WindowBar key={w.id} w={w} />)}
      </div>
      {rolling.binding === "credits" && soonest && (
        <p className="mt-5 rounded-xl bg-accent-soft px-4 py-3 text-sm text-accent-soft-fg" role="status">
          Your {short(soonest.id)} budget is used up. Credits are covering requests until it frees up in {fmtCountdown(soonest.resets_in_s)}.
        </p>
      )}
      {rolling.binding === "exhausted" && soonest && (
        <p className="mt-5 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg" role="alert">
          Requests are blocked: your {short(soonest.id)} budget is used up and there are no credits left. It frees up in {fmtCountdown(soonest.resets_in_s)}.
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-t border-separator pt-5">
        <div>
          <div className="text-sm text-muted">Usage credits</div>
          <div className="mt-1 font-mono text-[26px] font-semibold leading-8 tracking-tight text-accent tabular-nums">
            <Money value={rolling.credits.balance_usd} /> <span className="font-sans text-sm font-medium text-muted">left</span>
          </div>
        </div>
        <p className="max-w-[340px] text-sm leading-5 text-muted md:text-right">Used after your daily or monthly budget runs out. Credits don't reset.</p>
      </div>
      <p className="mt-4 text-xs leading-[17px] text-muted">
        Requests to models with no price set are charged the fallback price, {fmtRate(rolling.fallback_price.prompt_per_1m)} / {fmtRate(rolling.fallback_price.completion_per_1m)} per 1M tokens (input / output).
      </p>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
    </Card>
  );
}

export function Overview() {
  const toast = useToast();
  const [hours, setHours] = useState<"24" | "168" | "720">("168");
  const limits = useQuery({ queryKey: ["limits"], queryFn: api.limits });
  const activity = useQuery({ queryKey: ["activity", hours], queryFn: () => api.activity(Number(hours)) });
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const taste = useQuery({ queryKey: ["taste"], queryFn: api.taste });
  const verdicts = useQuery({ queryKey: ["taste-verdicts"], queryFn: api.tasteVerdicts });
  const points = activity.data?.points || [];

  return (
    <div>
      <h1 className="text-[26px] font-semibold tracking-tight">Overview</h1>
      <p className="mt-1 text-sm text-muted">{me.data ? `Signed in as ${limits.data?.name || me.data.key.name}. ` : ""}Your budget, usage and recent activity.</p>

      <div className="mt-6">
        <BudgetCard limits={limits.data} />
      </div>

      <div className="mt-10 flex items-end justify-between gap-4">
        <h2 className="text-[15px] font-semibold">Activity</h2>
        <Segmented
          ariaLabel="Window"
          value={hours}
          onChange={setHours}
          options={[{ value: "24", label: "24h" }, { value: "168", label: "7d" }, { value: "720", label: "30d" }]}
        />
      </div>

      {activity.isError ? (
        <div className="mt-4 flex items-center justify-between rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-fg">
          <span>Activity could not load.</span>
          <button className="font-medium underline" onClick={() => { activity.refetch(); toast("Retrying"); }}>Retry</button>
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Requests" value={fmtInt(activity.data?.totals.requests)} />
            <Stat label="Succeeded" value={fmtInt(activity.data?.totals.ok)} />
            <Stat label="Failed" value={fmtInt(activity.data?.totals.fail)} />
            <Stat label="Spend" value={fmtUsd(activity.data?.totals.spend_usd)} />
          </div>
          <Card className="mt-4 p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">Global activity</span>
              {points.length > 0 && <span className="font-mono text-sm font-medium text-accent tabular-nums">{points[points.length - 1].requests} requests</span>}
            </div>
            <ActivityChart points={points} />
          </Card>
        </>
      )}

      <TasteSection taste={taste.data} loading={taste.isLoading} verdicts={verdicts.data?.verdicts || []} />
    </div>
  );
}

const RULE_LABELS: Record<string, string> = {
  non_empty: "not empty",
  not_truncated: "not cut off",
  json_valid: "valid JSON",
  json_repairable: "repairable JSON",
  json_schema_ok: "schema match",
  tool_calls_valid: "tool calls",
  reasoning_missing: "reasoning present",
  style: "style"
};

function TasteSection({ taste, loading, verdicts }: { taste: Taste | undefined; loading: boolean; verdicts: Array<{ at: string; slug: string; score: number; violations: string[] }> }) {
  if (loading) return <Skeleton className="mt-10 h-[260px] rounded-[24px]" />;
  if (!taste || taste.samples === 0) {
    return (
      <div className="mt-10">
        <h2 className="text-[15px] font-semibold">Taste</h2>
        <Card className="mt-4 p-7 text-sm text-muted">
          Nothing measured yet. Every response through your keys is checked against rules a program can decide - valid JSON when asked, tool calls that match their schema, answers that are not cut off - and your profile builds from those verdicts. Only rule names and scores are ever recorded, never prompts or responses.
        </Card>
      </div>
    );
  }
  const pct = taste.taste == null ? null : Math.round(taste.taste * 100);
  const rules = Object.entries(taste.rules).sort((a, b) => b[1].n - a[1].n);
  const failed = verdicts.filter((v) => v.violations.length);
  return (
    <div className="mt-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold">Taste</h2>
          <p className="mt-1 text-sm text-muted">How often the models you use actually follow the rules, measured on your traffic. Rule verdicts only - no prompts, no responses.</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-semibold tabular-nums">{pct == null ? "-" : pct + "%"}</div>
          <div className="text-xs text-muted">{fmtInt(taste.samples)} verdicts</div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="p-5">
          <div className="text-sm text-muted">Rules, weighted by how often each is checked</div>
          <div className="mt-3 flex flex-col gap-2.5">
            {rules.map(([rule, r]) => (
              <div key={rule} className="flex items-center gap-3">
                <span className="w-32 shrink-0 text-sm">{RULE_LABELS[rule] || rule}</span>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-default">
                  <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(r.mean * 100)}%` }} />
                </div>
                <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-muted">{Math.round(r.mean * 100)}% · n={r.n}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-sm text-muted">Recent failed checks</div>
          {failed.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted">Every recent response passed every rule.</div>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {failed.slice(0, 8).map((v, i) => (
                <div key={i} className="flex items-baseline gap-3 text-sm">
                  <span className="shrink-0 font-mono text-xs text-muted">{v.at.slice(11, 19)}</span>
                  <span className="shrink-0 font-medium">{v.slug}</span>
                  <span className="min-w-0 truncate text-muted">{v.violations.map((r) => RULE_LABELS[r.split(":")[0]] || r).join(", ")}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {taste.trend.length > 1 && (
        <Card className="mt-4 p-5">
          <div className="text-sm text-muted">Score over the last 48 hours</div>
          <TasteSpark trend={taste.trend} />
        </Card>
      )}
    </div>
  );
}

function TasteSpark({ trend }: { trend: Array<{ hour: string; score: number; n: number }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!ref.current || trend.length < 2) return;
    const x = trend.map((p) => Math.round(new Date(p.hour).getTime() / 1000));
    const y = trend.map((p) => Math.round(p.score * 100));
    const styles = getComputedStyle(document.documentElement);
    const accentRaw = styles.getPropertyValue("--accent").trim() || "#4aa3f5";
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const c2 = canvas.getContext("2d", { willReadFrequently: true });
    let accent = accentRaw;
    if (c2) {
      c2.fillStyle = accentRaw;
      c2.fillRect(0, 0, 1, 1);
      const [r, g, b] = c2.getImageData(0, 0, 1, 1).data;
      accent = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
    }
    const muted = styles.getPropertyValue("--muted").trim() || "#999";
    const grid = styles.getPropertyValue("--separator").trim() || "#333";
    const u = new UPlot(
      {
        width: ref.current.clientWidth,
        height: 140,
        padding: [10, 10, 0, 0],
        legend: { show: false },
        cursor: { drag: { x: false, y: false } },
        series: [{}, { label: "Score", stroke: accent, width: 1.5, points: { show: false } }],
        axes: [
          { stroke: muted, font: "11px Inter, system-ui, sans-serif", grid: { show: false }, ticks: { show: false } },
          { stroke: muted, font: "11px Inter, system-ui, sans-serif", size: 36, grid: { stroke: grid, width: 1 }, ticks: { show: false }, values: (_u: UPlot, splits: number[]) => splits.map((s) => s + "%") }
        ],
        scales: { y: { range: [0, 105] } }
      },
      [x, y],
      ref.current
    );
    const ro = new ResizeObserver(() => u.setSize({ width: ref.current!.clientWidth, height: 140 }));
    ro.observe(ref.current);
    return () => { ro.disconnect(); u.destroy(); };
  }, [trend]);
  return <div ref={ref} className="mt-2 min-h-[140px]" aria-label="Taste score trend" />;
}

import UPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useRef, useLayoutEffect } from "react";

function ActivityChart({ points }: { points: Array<{ hour: string; requests: number; tokens: number; spend_usd: number }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<UPlot | null>(null);
  useLayoutEffect(() => {
    if (!ref.current || !points.length) return;
    const x = points.map((p) => Math.round(new Date(p.hour).getTime() / 1000));
    const y = points.map((p) => p.requests);
    const styles = getComputedStyle(document.documentElement);
    const toHex = (css: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const c = canvas.getContext("2d", { willReadFrequently: true });
      if (!c) return "";
      c.fillStyle = css;
      c.fillRect(0, 0, 1, 1);
      const [r, g, bb] = c.getImageData(0, 0, 1, 1).data;
      return "#" + [r, g, bb].map((n) => n.toString(16).padStart(2, "0")).join("");
    };
    const accent = styles.getPropertyValue("--accent").trim() || "#4aa3f5";
    const accentHex = toHex(accent) || "#4aa3f5";
    const muted = styles.getPropertyValue("--muted").trim() || "#999";
    const grid = styles.getPropertyValue("--separator").trim() || "#333";
    const u = new UPlot(
      {
        width: ref.current.clientWidth,
        height: 240,
        padding: [14, 10, 0, 0],
        legend: { show: false },
        cursor: { drag: { x: false, y: false }, points: { size: 7, fill: accentHex } },
        series: [
          {},
          {
            label: "Requests",
            stroke: accentHex,
            width: 1.75,
            fill: (uu: UPlot) => {
              const g = uu.ctx.createLinearGradient(0, uu.bbox.top, 0, uu.bbox.top + uu.bbox.height);
              g.addColorStop(0, accentHex + "30");
              g.addColorStop(1, accentHex + "00");
              return g;
            },
            points: { show: false }
          }
        ],
        axes: [
          { stroke: muted, font: "12px Inter, system-ui, sans-serif", grid: { show: false }, ticks: { stroke: grid, size: 4 } },
          { stroke: muted, font: "12px Inter, system-ui, sans-serif", size: 50, grid: { stroke: grid, width: 1 }, ticks: { show: false } }
        ],
        scales: { y: { range: (_u: UPlot, _min: number, max: number) => [0, Math.max(max * 1.12, 1)] } }
      },
      [x, y],
      ref.current
    );
    plotRef.current = u;
    const ro = new ResizeObserver(() => u.setSize({ width: ref.current!.clientWidth, height: 240 }));
    ro.observe(ref.current);
    return () => { ro.disconnect(); u.destroy(); plotRef.current = null; };
  }, [points]);
  if (!points.length) return <div className="py-10 text-center text-sm text-muted">No requests in this window.</div>;
  return <div ref={ref} className="mt-3 min-h-[240px]" aria-label="Activity chart" />;
}
