import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { Card, Switch, useToast } from "../lib/ui";

export function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const cache = settings.data?.response_cache;

  return (
    <div>
      <h1 className="text-[26px] font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted">Behaviour that applies to your keys only.</p>

      <Card className="mt-6 p-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="text-[15px] font-semibold">Response cache</h2>
            <p className="mt-1 max-w-[62ch] text-sm leading-5 text-muted">
              Identical chat requests can be answered from a stored completion instead of calling the provider again. Tool calls are never cached. This applies to your key only: turning it off stops caching for your requests, not anyone else's.
            </p>
            {cache && (
              <p className="mt-3 text-sm text-muted">
                <span className="font-mono text-foreground">{fmtInt(cache.entries)}</span> entries, <span className="font-mono text-foreground">{fmtInt(cache.hits)}</span> hits, saved <span className="font-mono text-foreground">{fmtUsd(cache.saved_usd)}</span> and <span className="font-mono text-foreground">{fmtInt(cache.saved_tokens)}</span> tokens
              </p>
            )}
          </div>
          {cache && (
            <Switch
              checked={cache.enabled}
              onChange={async (v) => {
                await api.setCache(v);
                qc.invalidateQueries({ queryKey: ["settings"] });
                toast(v ? "Cache on" : "Cache off");
              }}
            />
          )}
        </div>
      </Card>

      <Card className="mt-4 p-6">
        <h2 className="text-[15px] font-semibold">Reliability</h2>
        <p className="mt-1 max-w-[62ch] text-sm leading-5 text-muted">
          Tool-call repair is built into this gateway and always on for your traffic: malformed JSON, wrong types and tool-name casing in model tool calls are fixed for every provider, streaming or not. A call cut off by the length limit is dropped, never completed. Nothing here is configured per key.
        </p>
      </Card>
    </div>
  );
}
