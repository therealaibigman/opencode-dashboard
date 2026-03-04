'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';
import { useProject } from './ProjectContext';
import { useSettings } from './useSettings';
import { useRouter } from 'next/navigation';

type RunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  parentRunId: string | null;
  kind: 'execute' | 'plan';
  status: string;
  modelProfile: string;
  prUrl: string | null;
  prBranch: string | null;
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

function kindPill(kind: string) {
  if (kind === 'plan') return 'bg-yellow-500/10 text-yellow-100 ring-yellow-500/25';
  return 'bg-black/20 text-zinc-200 ring-matrix-500/15';
}

function RunButton({ r, onOpen, indent }: { r: RunRow; onOpen: () => void; indent?: boolean }) {
  return (
    <div
      className={
        indent
          ? 'block w-full min-w-0 rounded-xl border border-matrix-500/10 bg-black/20 p-3 pl-6'
          : 'block w-full min-w-0 rounded-xl border border-matrix-500/10 bg-black/25 p-3'
      }
    >
      <button onClick={onOpen} className="block w-full min-w-0 text-left hover:opacity-95">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 break-all text-sm font-medium text-zinc-100">{r.id}</div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-1 text-[11px] ring-1 ${kindPill(r.kind)}`}>{r.kind}</span>
            <span className={`rounded-full px-2 py-1 text-[11px] ring-1 ${pill(r.status)}`}>{r.status}</span>
          </div>
        </div>

        <div className="mt-2 grid gap-1 text-[11px] text-zinc-400 md:grid-cols-3">
          <div className="min-w-0 break-all">task: {r.taskId ?? '—'}</div>
          <div>created: {fmtTs(r.createdAt)}</div>
          <div>
            {r.startedAt ? `start: ${fmtTs(r.startedAt)}` : 'start: —'}
            {r.finishedAt ? ` • end: ${fmtTs(r.finishedAt)}` : ''}
          </div>
        </div>

        {indent && r.parentRunId ? <div className="mt-1 text-[10px] text-zinc-500">from plan: {r.parentRunId}</div> : null}
      </button>

      {r.prUrl ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <a
            className="rounded-lg bg-matrix-500/15 px-2 py-1 text-[11px] text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20"
            href={r.prUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            Open PR
          </a>
          {r.prBranch ? <div className="text-[10px] text-zinc-500">{r.prBranch}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function RunsPanel() {
  const BASE = useBasePath();
  const router = useRouter();
  const { selectedProjectId: projectId } = useProject();
  const { settings } = useSettings();

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const api = useMemo(
    () => ({
      runs: (cursor?: string | null) => {
        const qs = new URLSearchParams();
        qs.set('project_id', projectId);
        qs.set('limit', String(settings.runsPageSize || 100));
        if (cursor) qs.set('cursor', cursor);
        return `${BASE}/api/runs?${qs.toString()}`;
      }
    }),
    [BASE, projectId, settings.runsPageSize]
  );

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      const data = await j<{ runs: RunRow[]; next_cursor: string | null }>(await fetch(api.runs(null), { cache: 'no-store' }));
      setRuns(data.runs);
      setNextCursor(data.next_cursor);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setErr(null);
    try {
      const data = await j<{ runs: RunRow[]; next_cursor: string | null }>(await fetch(api.runs(nextCursor), { cache: 'no-store' }));
      setRuns((prev) => [...prev, ...(data.runs ?? [])]);
      setNextCursor(data.next_cursor);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, settings.runsPageSize]);

  const childrenByParent = new Map<string, RunRow[]>();
  for (const r of runs) {
    if (r.parentRunId) {
      const arr = childrenByParent.get(r.parentRunId) ?? [];
      arr.push(r);
      childrenByParent.set(r.parentRunId, arr);
    }
  }

  const topLevel = runs.filter((r) => !r.parentRunId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Project</div>
          <div className="rounded-lg border border-matrix-500/20 bg-black/25 px-3 py-2 text-sm text-zinc-100">{projectId}</div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh()}
            className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
          >
            Refresh
          </button>
          <div className="text-[11px] text-zinc-500">page size: {settings.runsPageSize || 100}</div>
        </div>
      </div>

      {err ? <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">{err}</div> : null}

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Recent runs</div>

        {loading ? <div className="text-[11px] text-zinc-400">Loading…</div> : null}

        {runs.length === 0 && !loading ? <div className="text-[11px] text-zinc-400">No runs yet.</div> : null}

        <div className="space-y-2">
          {topLevel.map((r) => {
            const kids = childrenByParent.get(r.id) ?? [];
            return (
              <div key={r.id} className="space-y-2">
                <RunButton r={r} onOpen={() => router.push(`/runs/${encodeURIComponent(r.id)}`)} />
                {kids.length ? (
                  <div className="space-y-2">
                    {kids.map((k) => (
                      <RunButton key={k.id} r={k} indent onOpen={() => router.push(`/runs/${encodeURIComponent(k.id)}`)} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {nextCursor ? (
          <div className="mt-3">
            <button
              onClick={() => loadMore()}
              disabled={loadingMore}
              className="w-full rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        ) : runs.length ? (
          <div className="mt-3 text-center text-[11px] text-zinc-500">End.</div>
        ) : null}
      </div>
    </div>
  );
}
