<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import UPlot from "uplot";
  import "uplot/dist/uPlot.min.css";

  type Point = { day: string; requests: number; tokens: number; spend_usd: number };
  type Metric = "requests" | "tokens" | "spend_usd";

  let { series, metric, days }: { series: Point[]; metric: Metric; days: number } = $props();

  let container: HTMLDivElement | undefined = $state();
  let plot: UPlot | null = null;
  let ro: ResizeObserver | null = null;
  let frame: number | null = null;

  const fmt = (v: number) =>
    metric === "spend_usd"
      ? "$" + (v >= 1 ? v.toFixed(0) : v.toFixed(2))
      : Intl.NumberFormat("en", { notation: v >= 100000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(v);

  function render() {
    if (!container || !series.length)
      return;
    try {
      const x = series.map((p) => Math.round(new Date(p.day + "T00:00:00Z").getTime() / 1000));
      const y = series.map((p) => Number(p[metric]) || 0);
      const styles = getComputedStyle(document.documentElement);
      const accent = styles.getPropertyValue("--accent").trim() || "#c74322";
      const border = styles.getPropertyValue("--border").trim() || "#d8dde3";

      plot?.destroy();
      plot = new UPlot(
        {
          width: container.clientWidth,
          height: 240,
          padding: [8, 8, 0, 0],
          cursor: { drag: { x: false, y: false }, points: { size: 5 } },
          series: [
            {},
            {
              label: metric === "spend_usd" ? "Spend" : metric.charAt(0).toUpperCase() + metric.slice(1),
              stroke: accent,
              width: 1.5,
              points: { show: true, size: 4 },
              value: (_u: UPlot, v: number | null) => (v == null ? "—" : fmt(v))
            }
          ],
          axes: [
            {
              values: (_u: UPlot, vals: number[]) =>
                vals.map((v) => new Date(v * 1000).toLocaleDateString("en", { month: "short", day: "numeric" }))
            },
            {
              size: 52,
              values: (_u: UPlot, vals: number[]) => vals.map((v) => (v === 0 ? "0" : fmt(v))),
              grid: { stroke: border, width: 1 },
              ticks: { stroke: border, width: 1 }
            }
          ],
          scales: {
            x: { min: x[0] - 43200, max: x[x.length - 1] + 43200 }
          },
          legend: { show: true, live: true }
        },
        [x, y],
        container
      );
    } catch {
      plot = null;
    }
  }

  // Rerender on data change, deferred to an animation frame so nothing throws
  // inside Svelte's reactive update. A throw there silently aborts the whole
  // branch render, freezing the page on its skeleton.
  function schedule() {
    if (frame != null)
      return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (container && Array.isArray(series) && series.length)
        render();
    });
  }

  // Track inputs defensively: the effect reads only what certainly exists.
  $effect(() => {
    if (container && series)
      schedule();
  });

  onMount(() => {
    ro = new ResizeObserver(() => {
      if (plot && container)
        plot.setSize({ width: container.clientWidth, height: 240 });
    });
    if (container)
      ro.observe(container);
  });

  onDestroy(() => {
    ro?.disconnect();
    if (frame != null)
      cancelAnimationFrame(frame);
    plot?.destroy();
    plot = null;
  });
</script>

<div bind:this={container} class="chart-wrap" aria-label="Usage chart"></div>

<style>
  .chart-wrap {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
    padding: 12px;
  }

  .chart-wrap :global(.uplot) {
    font-family: var(--font-sans);
  }

  .chart-wrap :global(.uplot .u-legend) {
    font-size: 12px;
    color: var(--text-muted);
  }

  .chart-wrap :global(.uplot .u-legend .u-series:first-child th) {
    color: var(--text);
    font-weight: 500;
  }

  .chart-wrap :global(.uplot .u-axis text) {
    fill: var(--text-muted);
  }
</style>
