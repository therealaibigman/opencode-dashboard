'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';
import { useProject } from './ProjectContext';
import { useRouter } from 'next/navigation';

type RunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  status: string;
  modelProfile: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

function fmtTs(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function pill(status: string) {
  if (status === 'succeeded') return 'bg-matrix-500/15 text-matrix-100 ring-matrix-500/30';
  if (status === 'failed') return 'bg-red-500/15 text-red-100 ring-red-500/30';
  if (status === 'running') return 'bg-blue-500/15 text-blue-100 ring-blue-500/30';
  if (status === 'queued') return 'bg-zinc-500/15 text-zinc-100 ring-zinc-500/30';
  return 'bg-black/20 text-zinc-200 ring-matrix-500/15';
}

export function RunsPanel() {
  const BASE = useBasePath();
  const router = useRouter();
  const { selectedProjectId: projectId } = useProject();

  const api = useMemo(
    () => ({
      runs: `${BASE}/api/runs?project_id=${encodeURIComponent(projectId)}`,
      runPage: (id: string) => `${BASE}/runs/${encodeURIComponent(id)}`
    }),
    [BASE, projectId]
  );

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      const data = await j<{ runs: RunRow[] }>(await fetch(api.runs, { cache: 'no-store' }));
      setRuns(data.runs);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.runs]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Project</div>
          <div className="rounded-lg border border-matrix-500/20 bg-black/25 px-3 py-2 text-sm text-zinc-100">
            {projectId}
          </div>
        </div>

        <button
          onClick={() => refresh()}
          className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
        >
          Refresh
        </button>
      </div>

      {err ? (
        <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">{err}</div>
      ) : null}

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Recent runs</div>

        {loading ? <div className="text-[11px] text-zinc-400">Loading…</div> : null}

        {runs.length === 0 && !loading ? (
          <div className="text-[11px] text-zinc-400">No runs yet.</div>
        ) : null}

        <div className="space-y-2">
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => router.push(api.runPage(r.id))}
              className="block w-full min-w-0 rounded-xl border border-matrix-500/10 bg-black/25 p-3 text-left hover:bg-black/35"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 break-all text-sm font-medium text-zinc-100">{r.id}</div>
                <span className={`rounded-full px-2 py-1 text-[11px] ring-1 ${pill(r.status)}`}>{r.status}</span>
              </div>

              <div className="mt-2 grid gap-1 text-[11px] text-zinc-400 md:grid-cols-3">
                <div className="min-w-0 break-all">task: {r.taskId ?? '—'}</div>
                <div>created: {fmtTs(r.createdAt)}</div>
                <div>
                  {r.startedAt ? `start: ${fmtTs(r.startedAt)}` : 'start: —'}
                  {r.finishedAt ? ` • end: ${fmtTs(r.finishedAt)}` : ''}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="text-[10px] text-zinc-500">source: {api.runs}</div>
    </div>
  );
}
