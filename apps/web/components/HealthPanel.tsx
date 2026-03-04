'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export function HealthPanel() {
  const BASE = useBasePath();
  const api = useMemo(() => ({ health: `${BASE}/api/health` }), [BASE]);

  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setErr(null);
    try {
      const d = await j(await fetch(api.health, { cache: 'no-store' }));
      setData(d);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.health]);

  return (
    <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-matrix-200/90">Deploy checklist</div>
        <button
          onClick={() => refresh()}
          className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
        >
          Refresh
        </button>
      </div>

      {err ? <div className="rounded-lg border border-red-500/30 bg-red-950/30 p-2 text-xs text-red-100">{err}</div> : null}

      {!data ? <div className="text-[11px] text-zinc-400">Loading…</div> : null}

      {data ? (
        <div className="space-y-3 text-xs text-zinc-200">
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-xl border border-matrix-500/15 bg-black/20 p-2">
              <div className="text-[11px] text-zinc-400">DB</div>
              <div className={data.db?.ok ? 'text-matrix-100' : 'text-red-100'}>{data.db?.ok ? 'OK' : 'FAIL'}</div>
              {data.db?.error ? <div className="mt-1 whitespace-pre-wrap text-[10px] text-zinc-400">{data.db.error}</div> : null}
            </div>

            <div className="rounded-xl border border-matrix-500/15 bg-black/20 p-2">
              <div className="text-[11px] text-zinc-400">OpenCode</div>
              <div className={data.opencode?.ok ? 'text-matrix-100' : 'text-red-100'}>
                {data.opencode?.ok ? data.opencode.output : 'FAIL'}
              </div>
              {data.opencode?.error ? <div className="mt-1 whitespace-pre-wrap text-[10px] text-zinc-400">{data.opencode.error}</div> : null}
            </div>

            <div className="rounded-xl border border-matrix-500/15 bg-black/20 p-2">
              <div className="text-[11px] text-zinc-400">GitHub (gh)</div>
              <div className={data.gh?.ok ? 'text-matrix-100' : 'text-yellow-100'}>{data.gh?.ok ? 'OK' : 'Check auth'}</div>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] text-zinc-400">
                {data.gh?.ok ? data.gh.output : data.gh?.error}
              </pre>
            </div>

            <div className="rounded-xl border border-matrix-500/15 bg-black/20 p-2">
              <div className="text-[11px] text-zinc-400">Disk</div>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[10px] text-zinc-400">
                {data.disk?.ok ? data.disk.output : data.disk?.error}
              </pre>
            </div>
          </div>

          <div className="text-[10px] text-zinc-500">/api/health</div>
        </div>
      ) : null}
    </div>
  );
}
