'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';
import { useSettings } from './useSettings';

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export function GsdPanel() {
  const BASE = useBasePath();
  const { settings, setDefaultPipelineId } = useSettings();

  const [pipelines, setPipelines] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingDefault, setCreatingDefault] = useState(false);

  const api = useMemo(
    () => ({
      pipelines: `${BASE}/api/pipelines`
    }),
    [BASE]
  );

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      const data = await j<{ pipelines: any[] }>(await fetch(api.pipelines, { cache: 'no-store' }));
      setPipelines(data.pipelines);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function createDefault() {
    setErr(null);
    setCreatingDefault(true);
    try {
      await j(
        await fetch(api.pipelines, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ create_default: true })
        })
      );
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setCreatingDefault(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.pipelines]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">GSD Mode</div>
        <div className="text-xs text-zinc-400">Global pipeline templates. Runs can select a pipeline.</div>
      </div>

      {err ? <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">{err}</div> : null}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => refresh()}
          className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
        >
          Refresh
        </button>
        <button
          onClick={() => createDefault()}
          disabled={creatingDefault}
          className="rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20 disabled:opacity-60"
        >
          {creatingDefault ? 'Creating…' : 'Create default pipeline'}
        </button>
      </div>

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Pipelines</div>
        {loading ? <div className="text-[11px] text-zinc-400">Loading…</div> : null}
        {pipelines.length === 0 && !loading ? <div className="text-[11px] text-zinc-400">No pipelines yet.</div> : null}
        <div className="space-y-2">
          {pipelines.map((p) => (
            <div key={p.id} className="rounded-xl border border-matrix-500/10 bg-black/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-zinc-100">{p.name}</div>
                <div className="text-[11px] text-zinc-400">{p.version}</div>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <div className="break-all text-[10px] text-zinc-500">{p.id}</div>
                <button
                  onClick={() => setDefaultPipelineId(p.id)}
                  className="rounded-lg bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
                >
                  {settings.defaultPipelineId === p.id ? 'Default' : 'Use as default'}
                </button>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-zinc-300">graph_json</summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px] text-zinc-200">
                  {JSON.stringify(p.graphJson ?? p.graph_json ?? {}, null, 2)}
                </pre>
              </details>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Note</div>
        <div className="text-xs text-zinc-400">
          Step execution UI is on the run page (Steps panel). Pipeline selection per-run is next.
        </div>
        <div className="mt-2 text-xs text-zinc-500">Default pipeline: {settings.defaultPipelineId || '—'}
        </div>
        <div className="mt-2 text-xs text-zinc-500">(Model profile default currently: {settings.modelProfile})</div>
      </div>
    </div>
  );
}
