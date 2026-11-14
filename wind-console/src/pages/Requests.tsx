import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtInt, fmtMs, fmtUsd, type RequestRow } from "../lib/api";
import { Segmented, Skeleton } from "../lib/ui";
import { motion, AnimatePresence } from "framer-motion";

const EASE = [0.23, 1, 0.32, 1] as const;

function StatusChip({ status }: { status: number | null }) {
  const cls = status === 200 ? "bg-success-soft text-success-soft-fg" : status == null ? "bg-default text-muted" : "bg-danger-soft text-danger-soft-fg";
  return <span className={"inline-flex rounded-full px-2 py-0.5 font-mono text-xs font-medium " + cls}>{status ?? "-"}</span>;
}

export function Requests() {
  const [days, setDays] = useState<"1" | "7" | "30">("7");
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["requests", days], queryFn: () => api.requests(Number(days), 50) });
  const detail = useQuery({ queryKey: ["request", open], queryFn: () => api.request(open!), enabled: !!open });

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Requests</h1>
          <p className="mt-1 text-sm text-muted">Every request through this account, newest first.</p>
        </div>
        <Segmented ariaLabel="Window" value={days} onChange={setDays} options={[{ value: "1", label: "24h" }, { value: "7", label: "7d" }, { value: "30", label: "30d" }]} />
      </div>

      <div className="mt-6 overflow-x-auto rounded-[20px] bg-surface shadow-[var(--surface-shadow)]">
        {list.isLoading ? (
          <div className="flex flex-col gap-2 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />)}</div>
        ) : list.isError ? (
          <div className="p-8 text-center text-sm text-muted">Requests could not load. <button className="font-medium underline" onClick={() => list.refetch()}>Retry</button></div>
        ) : (list.data?.requests || []).length === 0 ? (
          <div className="p-10 text-center text-sm text-muted">No requests in this window. Send one with your API key and it appears here.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 text-start text-xs text-muted">
                <th className="rounded-tl-[20px] px-4 py-2.5 text-start font-medium">Time</th>
                <th className="px-4 py-2.5 text-start font-medium">Model</th>
                <th className="px-4 py-2.5 text-start font-medium">Status</th>
                <th className="px-4 py-2.5 text-start font-medium">Latency</th>
                <th className="px-4 py-2.5 text-end font-medium">Tokens</th>
                <th className="rounded-tr-[20px] px-4 py-2.5 text-end font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.requests || []).map((r: RequestRow) => (
                <tr key={r.id} className="cursor-pointer border-b border-separator transition-colors last:border-0 hover:bg-default" onClick={() => setOpen(r.id)}>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{r.created_at.slice(5, 16).replace("T", " ")}</td>
                  <td className="whitespace-nowrap px-4 py-3">{r.slug}</td>
                  <td className="px-4 py-3"><StatusChip status={r.http_status} /></td>
                  <td className="whitespace-nowrap px-4 py-3">{fmtMs(r.latency_ms)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-end font-mono tabular-nums">{r.tokens ? fmtInt(r.tokens) : "-"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-end font-mono tabular-nums">{fmtUsd(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AnimatePresence>
        {open && (
          <>
            <motion.div className="fixed inset-0 z-40 bg-[var(--backdrop)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={() => setOpen(null)} />
            <motion.aside
              className="fixed inset-y-0 right-0 z-50 w-full max-w-[440px] overflow-y-auto bg-overlay p-6 shadow-[var(--overlay-shadow)]"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.26, ease: EASE }}
              aria-label="Request detail"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Request</h2>
                <button className="rounded-full px-3 py-1.5 text-sm text-muted transition-colors hover:bg-default hover:text-foreground" onClick={() => setOpen(null)}>Close</button>
              </div>
              {detail.isLoading ? (
                <div className="mt-6 flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} />)}</div>
              ) : detail.isError ? (
                <p className="mt-6 text-sm text-muted">Could not load this request.</p>
              ) : (
                <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                  {Object.entries(detail.data || {})
                    .filter(([k, v]) => v != null && k !== "headers" && k !== "prompt")
                    .map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted">{k.replace(/_/g, " ")}</dt>
                        <dd className="break-all font-mono text-xs leading-5">{String(v)}</dd>
                      </div>
                    ))}
                </dl>
              )}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
