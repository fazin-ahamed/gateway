<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import UPlot from "uplot";
  import "uplot/dist/uPlot.min.css";

  type Point = { t: string; requests: number; tokens: number; spend_usd: number };
  type Metric = "requests" | "tokens" | "spend_usd";

  let { series, metric, windowHours = 0 }: { series: Point[]; metric: Metric; windowHours?: number } = $props();

  let container: HTMLDivElement | undefined = $state();
  let plot: UPlot | null = null;
  let ro: ResizeObserver | null = null;
  let frame: number | null = null;
  let hover = $state<{ when: string; value: string } | null>(null);
  const latest = $derived(series.length ? { when: when(Math.round(new Date(series[series.length - 1].t).getTime() / 1000)), value: fmt(Number(series[series.length - 1][metric]) || 0) } : null);
  const shown = $derived(hover ?? latest);

  const label = $derived(metric === "spend_usd" ? "Spend" : metric === "tokens" ? "Tokens" : "Requests");

  function fmt(v: number) {
    if (metric === "spend_usd") return "$" + (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4));
    return Intl.NumberFormat("en", { notation: v >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(v);
  }

  function when(sec: number) {
    return new Date(sec * 1000).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric" });
  }

  function render() {
    if (!container || !series.length) return;
    const x = series.map((p) => Math.round(new Date(p.t).getTime() / 1000));
    const y = series.map((p) => Number(p[metric]) || 0);
    hover = { when: when(x[x.length - 1]), value: fmt(y[y.length - 1]) };
    try {
      const span = Math.max(3600, (x[x.length - 1] || 0) - (x[0] || 0));
      const styles = getComputedStyle(document.documentElement);
      const accent = styles.getPropertyValue("--accent").trim() || "#d7a15a";
      const grid = styles.getPropertyValue("--border").trim() || "#2a241c";
      const peak = Math.max(...y, 0);

      plot?.destroy();
      plot = new UPlot(
        {
          width: container.clientWidth,
          height: 280,
          padding: [16, 12, 0, 0],
          cursor: {
            drag: { x: false, y: false },
            points: { size: 8, fill: accent },
            x: true,
            y: false
          },
          hooks: {
            setCursor: [
              (u) => {
                const i = u.cursor.idx;
                if (i == null || i < 0) {
                  hover = null;
                  return;
                }
                hover = { when: when(u.data[0][i]), value: fmt(u.data[1][i] || 0) };
              }
            ]
          },
          series: [
            {},
            {
              label,
              stroke: accent,
              width: 2,
              fill: accent + "22",
              points: { show: true, size: 6, stroke: accent, fill: accent },
              value: (_u: UPlot, v: number | null) => (v == null ? "—" : fmt(v))
            }
          ],
          axes: [
            {
              stroke: grid,
              grid: { show: false },
              ticks: { stroke: grid, size: 4 },
              values: (_u: UPlot, vals: number[]) => {
                let lastDay = "";
                return vals.map((v) => {
                  const day = new Date(v * 1000).toLocaleDateString("en", { month: "short", day: "numeric" });
                  if (day === lastDay) return "";
                  lastDay = day;
                  return day;
                });
              }
            },
            {
              stroke: grid,
              size: 56,
              values: (_u: UPlot, vals: number[]) => vals.map((v) => (v === 0 ? "0" : fmt(v))),
              grid: { stroke: grid, width: 1 },
              ticks: { show: false }
            }
          ],
          scales: {
            x: { min: x[0] - span * 0.02, max: x[x.length - 1] + span * 0.02 }
          },
          legend: { show: false }
        },
        [x, y],
        container
      );
      const last = series.length - 1;
      hover = { when: when(x[last]), value: fmt(y[last]) };
    } catch {
      plot = null;
    }
  }

  function schedule() {
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (container && Array.isArray(series) && series.length) render();
    });
  }

  $effect(() => {
    void metric;
    void windowHours;
    void series.length;
    void series[0]?.t;
    void series.at(-1)?.t;
    if (container) schedule();
  });

  onMount(() => {
    ro = new ResizeObserver(() => {
      if (plot && container) plot.setSize({ width: container.clientWidth, height: 280 });
    });
    if (container) ro.observe(container);
  });

  onDestroy(() => {
    ro?.disconnect();
    if (frame != null) cancelAnimationFrame(frame);
    plot?.destroy();
    plot = null;
  });
</script>

<div class="chart">
  <div class="readout" aria-live="polite">
    {#if shown}
      <span class="when">{shown.when}</span>
      <span class="read">{label} {shown.value}</span>
    {:else}
      <span class="when">No activity in this window</span>
    {/if}
  </div>
  <div bind:this={container} class="plot" aria-label="Activity chart"></div>
</div>

<style>
  .chart {
    border: 1px solid var(--border);
    background: var(--surface);
  }

  .readout {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 12px 16px 0;
    font-size: 13px;
  }

  .when {
    color: var(--text-muted);
  }

  .read {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: var(--accent);
  }

  .plot {
    width: 100%;
    min-height: 280px;
  }

  .plot :global(.uplot) {
    font-family: var(--font-sans);
  }
</style>
