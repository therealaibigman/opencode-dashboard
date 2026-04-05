'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';

type AdminRunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  kind: string;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  attemptCount: number;
  nextEligibleAt: string | null;
};

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

function fmt(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { hour12: false });
}

function backoff(nextEligibleAt: string | null) {
  if (!nextEligibleAt) return '—';
  const d = new Date(nextEligibleAt);
  const ms = d.getTime() - Date.now();
  if (Number.isNaN(ms)) return '—';
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.ceil(s / 60);
  return `${m}m`;
}

function pill(status: string) {
  if (status === 'succeeded') return 'bg-matrix-500/15 text-matrix-100 ring-matrix-500/30';
  if (status === 'failed') return 'bg-red-500/15 text-red-100 ring-red-500/30';
  if (status === 'running') return 'bg-blue-500/15 text-blue-100 ring-blue-500/30';
  if (status === 'claimed') return 'bg-purple-500/15 text-purple-100 ring-purple-500/30';
  if (status === 'retry_wait') return 'bg-yellow-500/15 text-yellow-100 ring-yellow-500/30';
  if (status === 'queued') return 'bg-zinc-500/15 text-zinc-100 ring-zinc-500/30';
  return 'bg-black/20 text-zinc-200 ring-matrix-500/15';
}

export function AdminRunsPanel() {
  const BASE = useBasePath();

  const [rows, setRows] = useState<AdminRunRow[]>([]);
  const [projectId, setProjectId] = useState('');
  const [onlyRetried, setOnlyRetried] = useState(true);
  const [activeOnly, setActiveOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const api = useMemo(() => {
    const qs = new URLSearchParams();
    if (projectId.trim()) qs.set('project_id', projectId.trim());
    if (onlyRetried) qs.set('only_retried', '1');
    if (activeOnly) qs.set('active_only', '1');
    qs.set('limit', '200');
    return `${BASE}/api/admin/runs?${qs.toString()}`;
  }, [BASE, projectId, onlyRetried, activeOnly]);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const data = await j<{ runs: AdminRunRow[] }>(await fetch(api, { cache: 'no-store' }));
      setRows(data.runs ?? []);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Admin: runs (retries/backoff)</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="project id (blank = all)"
              className="w-64 rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />
            <label className="flex select-none items-center gap-2 text-[12px] text-zinc-300">
              <input type="checkbox" checked={onlyRetried} onChange={(e) => setOnlyRetried(e.target.checked)} />
              only retried
            </label>
            <label className="flex select-none items-center gap-2 text-[12px] text-zinc-300">
              <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
              active-ish only
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh()}
            className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
          >
            Refresh
          </button>
          <div className="text-[11px] text-zinc-500">rows: {rows.length}</div>
        </div>
      </div>

      {err ? <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">{err}</div> : null}

      <div className="overflow-auto rounded-2xl border border-matrix-500/20 bg-black/20">
        <table className="min-w-[1100px] w-full text-left text-[12px]">
          <thead className="sticky top-0 bg-black/60 backdrop-blur">
            <tr className="text-zinc-300">
              <th className="px-3 py-2">status</th>
              <th className="px-3 py-2">attempts</th>
              <th className="px-3 py-2">backoff</th>
              <th className="px-3 py-2">run</th>
              <th className="px-3 py-2">project</th>
              <th className="px-3 py-2">kind</th>
              <th className="px-3 py-2">claimed</th>
              <th className="px-3 py-2">heartbeat</th>
              <th className="px-3 py-2">created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-matrix-500/10">
            {loading ? (
              <tr>
                <td className="px-3 py-3 text-zinc-400" colSpan={9}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-3 py-3 text-zinc-400" colSpan={9}>
                  No rows.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="text-zinc-200">
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-1 text-[11px] ring-1 ${pill(r.status)}`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.attemptCount ?? 0}</td>
                  <td className="px-3 py-2 tabular-nums">{backoff(r.nextEligibleAt)}</td>
                  <td className="px-3 py-2">
                    <a className="break-all text-matrix-200 hover:underline" href={`/runs/${encodeURIComponent(r.id)}`}>
                      {r.id}
                    </a>
                    {r.taskId ? <div className="mt-1 break-all text-[10px] text-zinc-500">task: {r.taskId}</div> : null}
                  </td>
                  <td className="px-3 py-2 break-all text-zinc-300">{r.projectId}</td>
                  <td className="px-3 py-2 text-zinc-300">{r.kind}</td>
                  <td className="px-3 py-2">
                    <div className="text-[11px] text-zinc-300">{r.claimedBy ?? '—'}</div>
                    <div className="text-[10px] text-zinc-500">{fmt(r.claimedAt)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-[10px] text-zinc-500">{fmt(r.heartbeatAt)}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-[10px] text-zinc-500">{fmt(r.createdAt)}</div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-zinc-500">
        "reaped" ≈ attempt_count &gt; 0. backoff computed from next_eligible_at.
      </div>
    </div>
  );
}
