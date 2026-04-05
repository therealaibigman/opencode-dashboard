'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';
import { useProject } from './ProjectContext';

type LoopRun = {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  pr_url?: string | null;
  pr_branch?: string | null;
};

type LoopRow = {
  loop_index: number;
  execute: LoopRun | null;
  review: LoopRun | null;
  publish: LoopRun | null;
  review_verdict: { contentText: string; createdAt: string } | null;
};

type TaskRow = {
  task: { id: string; title: string; status: string; updatedAt: string };
  loops: LoopRow[];
};

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

function pill(status: string) {
  if (status === 'succeeded') return 'bg-matrix-500/15 text-matrix-100 ring-matrix-500/30';
  if (status === 'failed') return 'bg-red-500/15 text-red-100 ring-red-500/30';
  if (status === 'running') return 'bg-blue-500/15 text-blue-100 ring-blue-500/30';
  if (status === 'claimed') return 'bg-purple-500/15 text-purple-100 ring-purple-500/30';
  if (status === 'needs_approval') return 'bg-yellow-500/15 text-yellow-100 ring-yellow-500/30';
  if (status === 'queued') return 'bg-zinc-500/15 text-zinc-100 ring-zinc-500/30';
  return 'bg-black/20 text-zinc-200 ring-matrix-500/15';
}

function fmtShort(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function StepCell({ r, label, basePath }: { r: LoopRun | null; label: string; basePath: string }) {
  if (!r) return <div className="text-[11px] text-zinc-500">—</div>;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-2 py-1 text-[11px] ring-1 ${pill(r.status)}`}>{label}: {r.status}</span>
        <a className="text-[11px] text-matrix-200 hover:underline" href={`${basePath}/runs/${encodeURIComponent(r.id)}`}>open</a>
      </div>
      <div className="text-[10px] text-zinc-500">{fmtShort(r.created_at)}{r.finished_at ? ` → ${fmtShort(r.finished_at)}` : ''}</div>
      {r.pr_url ? (
        <a className="text-[10px] text-matrix-200/90 hover:underline break-all" href={r.pr_url} target="_blank" rel="noreferrer">
          PR
        </a>
      ) : null}
    </div>
  );
}

export function RalphPanel() {
  const BASE = useBasePath();
  const { selectedProjectId: projectId } = useProject();

  const [rows, setRows] = useState<TaskRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyTask, setBusyTask] = useState<string | null>(null);

  const api = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set('project_id', projectId);
    qs.set('limit_tasks', '50');
    return {
      ralph: `${BASE}/api/admin/ralph?${qs.toString()}`,
      resume: (taskId: string) => `${BASE}/api/tasks/${encodeURIComponent(taskId)}/ralph/resume`
    };
  }, [BASE, projectId]);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const data = await j<{ tasks: TaskRow[] }>(await fetch(api.ralph, { cache: 'no-store' }));
      setRows(data.tasks ?? []);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.ralph]);

  async function resume(taskId: string) {
    setBusyTask(taskId);
    setErr(null);
    try {
      const data = await j<{ ok: boolean; run_id: string }>(
        await fetch(api.resume(taskId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'Resume anyway from Ralph panel' })
        })
      );
      await refresh();
      // keep user in context: open the new run
      window.location.href = `${BASE}/runs/${encodeURIComponent(data.run_id)}`;
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusyTask(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-zinc-300">Ralph Loop</div>
          <div className="text-[11px] text-zinc-500">Shows execute → review → publish ladders per task. “Resume anyway” enqueues a new execute run.</div>
        </div>
        <button
          onClick={() => refresh()}
          className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
        >
          Refresh
        </button>
      </div>

      {err ? <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">{err}</div> : null}

      <div className="space-y-3">
        {loading ? <div className="text-[11px] text-zinc-400">Loading…</div> : null}
        {!loading && rows.length === 0 ? <div className="text-[11px] text-zinc-400">No tasks.</div> : null}

        {rows.map((tr) => (
          <div key={tr.task.id} className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium text-zinc-100 break-words">{tr.task.title}</div>
                <div className="text-[11px] text-zinc-500 break-all">{tr.task.id} • status: {tr.task.status}</div>
              </div>

              {tr.task.status === 'blocked' ? (
                <button
                  onClick={() => resume(tr.task.id)}
                  disabled={busyTask === tr.task.id}
                  className="rounded-lg bg-yellow-500/15 px-3 py-2 text-sm text-yellow-100 ring-1 ring-yellow-500/30 hover:bg-yellow-500/20 disabled:opacity-60"
                >
                  {busyTask === tr.task.id ? 'Resuming…' : 'Resume anyway'}
                </button>
              ) : null}
            </div>

            <div className="mt-3 space-y-3">
              {tr.loops.map((lp) => (
                <div key={lp.loop_index} className="rounded-xl border border-matrix-500/10 bg-black/15 p-3">
                  <div className="mb-2 text-[11px] text-zinc-400">loop_index: {lp.loop_index}</div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <StepCell r={lp.execute} label="execute" basePath={BASE} />
                    <StepCell r={lp.review} label="review" basePath={BASE} />
                    <StepCell r={lp.publish} label="publish" basePath={BASE} />
                  </div>

                  {lp.review_verdict?.contentText ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-200">review verdict</summary>
                      <pre className="mt-2 overflow-auto rounded-lg bg-black/30 p-2 text-[10px] text-zinc-200">{lp.review_verdict.contentText}</pre>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
