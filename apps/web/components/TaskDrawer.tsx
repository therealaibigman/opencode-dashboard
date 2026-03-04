'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useBasePath } from './useBasePath';
import { useProject } from './ProjectContext';
import { RunTimeline } from './RunTimeline';

type TaskStatus = 'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';

type Task = {
  id: string;
  title: string;
  bodyMd: string;
  status: TaskStatus;
  archivedAt: string | null;
};

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

export function TaskDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const BASE = useBasePath();
  const router = useRouter();
  const { selectedProjectId: projectId } = useProject();

  const [title, setTitle] = useState(task.title);
  const [bodyMd, setBodyMd] = useState(task.bodyMd);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [archivedAt, setArchivedAt] = useState<string | null>(task.archivedAt ?? null);

  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [queueing, setQueueing] = useState<'plan' | 'execute' | null>(null);

  const api = useMemo(
    () => ({
      runs: `${BASE}/api/runs`,
      task: `${BASE}/api/tasks/${encodeURIComponent(task.id)}`
    }),
    [BASE, task.id]
  );

  async function refreshRuns() {
    setErr(null);
    try {
      const data = await j<{ runs: RunRow[] }>(
        await fetch(
          `${api.runs}?project_id=${encodeURIComponent(projectId)}&task_id=${encodeURIComponent(task.id)}`,
          { cache: 'no-store' }
        )
      );
      setRuns(data.runs);
      if (!selectedRunId && data.runs.length) setSelectedRunId(data.runs[0]!.id);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function saveTask() {
    setErr(null);
    setSaving(true);
    try {
      await j(
        await fetch(api.task, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title,
            body_md: bodyMd,
            status,
            archived: Boolean(archivedAt)
          })
        })
      );
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function archiveTask() {
    const ok = window.confirm('Archive this task?');
    if (!ok) return;

    setErr(null);
    setSaving(true);
    try {
      await j(
        await fetch(api.task, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ archived: true })
        })
      );
      setArchivedAt(new Date().toISOString());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function restoreToInbox() {
    setErr(null);
    setSaving(true);
    try {
      await j(
        await fetch(api.task, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ archived: false, status: 'inbox' })
        })
      );
      setArchivedAt(null);
      setStatus('inbox');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  }

  const latestPlan = runs.find((r) => r.kind === 'plan') ?? null;
  const latestExec = runs.find((r) => r.kind === 'execute') ?? null;

  async function queue(kind: 'plan' | 'execute', parentRunId?: string | null) {
    setErr(null);
    setQueueing(kind);
    try {
      const res = await fetch(api.runs, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          task_id: task.id,
          model_profile: 'balanced',
          kind,
          parent_run_id: parentRunId ?? null
        })
      });
      const data = await j<{ run: { id: string } }>(res);
      setSelectedRunId(data.run.id);
      router.push(`${BASE}/runs/${encodeURIComponent(data.run.id)}`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setQueueing(null);
    }
  }

  useEffect(() => {
    refreshRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, projectId]);

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div className="absolute right-0 top-0 h-full w-full max-w-3xl border-l border-matrix-500/20 bg-bg-2/90 shadow-neon backdrop-blur">
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-matrix-500/15 p-4">
            <div className="min-w-0">
              <div className="text-xs text-zinc-400">Task</div>

              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full min-w-0 rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
              />

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span className="break-all">{task.id}</span>
                <span>·</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TaskStatus)}
                  className="rounded-md border border-matrix-500/20 bg-black/30 px-2 py-1 text-xs text-zinc-100 outline-none"
                >
                  {['inbox', 'planned', 'in_progress', 'blocked', 'review', 'done'].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {archivedAt ? (
                  <span className="rounded-full bg-zinc-500/15 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-zinc-500/20">
                    archived
                  </span>
                ) : null}
              </div>

              <textarea
                value={bodyMd}
                onChange={(e) => setBodyMd(e.target.value)}
                placeholder="Task details…"
                className="mt-3 w-full min-h-24 rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
              />

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={saveTask}
                  disabled={saving}
                  className="rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20 disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>

                <button
                  onClick={() => queue('plan')}
                  disabled={saving || queueing !== null}
                  className="rounded-lg bg-blue-500/20 px-3 py-2 text-sm font-medium text-blue-50 ring-1 ring-blue-500/40 hover:bg-blue-500/25 disabled:opacity-60"
                >
                  {queueing === 'plan' ? 'Planning…' : 'Plan'}
                </button>

                <button
                  onClick={() => queue('execute')}
                  disabled={saving || queueing !== null}
                  className="rounded-lg bg-matrix-500/25 px-3 py-2 text-sm font-medium text-matrix-50 ring-1 ring-matrix-500/50 hover:bg-matrix-500/30 disabled:opacity-60"
                >
                  {queueing === 'execute' ? 'Executing…' : 'Execute'}
                </button>

                <button
                  onClick={() => queue('execute', latestPlan?.id ?? null)}
                  disabled={saving || queueing !== null || !latestPlan}
                  className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
                  title={latestPlan ? `Uses plan ${latestPlan.id}` : 'No plan run available'}
                >
                  Execute from latest plan
                </button>

                {!archivedAt ? (
                  <button
                    onClick={archiveTask}
                    disabled={saving}
                    className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
                  >
                    Archive
                  </button>
                ) : (
                  <button
                    onClick={restoreToInbox}
                    disabled={saving}
                    className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
                  >
                    Restore to inbox
                  </button>
                )}

                <button
                  onClick={refreshRuns}
                  className="rounded-lg bg-black/20 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/30"
                >
                  Refresh runs
                </button>
              </div>

              {latestExec?.prUrl ? (
                <div className="mt-2 text-xs text-zinc-200">
                  Latest PR:{' '}
                  <a className="break-all text-matrix-200/90 hover:underline" href={latestExec.prUrl} target="_blank" rel="noreferrer">
                    {latestExec.prUrl}
                  </a>
                </div>
              ) : null}

              {err ? (
                <div className="mt-3 rounded-lg border border-red-500/30 bg-red-950/30 p-2 text-xs text-red-100">{err}</div>
              ) : null}
            </div>

            <button
              onClick={onClose}
              className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
            >
              Close
            </button>
          </div>

          <div className="grid flex-1 gap-3 p-4 md:grid-cols-5">
            <div className="md:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-medium text-matrix-200/90">Runs</div>
                <button
                  onClick={refreshRuns}
                  className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
                >
                  Refresh
                </button>
              </div>

              <div className="space-y-2">
                {runs.length === 0 ? (
                  <div className="rounded-lg border border-matrix-500/10 bg-black/20 p-2 text-xs text-zinc-400">No runs yet.</div>
                ) : null}
                {runs.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRunId(r.id)}
                    className={
                      selectedRunId === r.id
                        ? 'w-full rounded-lg border border-matrix-500/30 bg-matrix-500/10 p-2 text-left text-xs text-zinc-100'
                        : 'w-full rounded-lg border border-matrix-500/10 bg-black/20 p-2 text-left text-xs text-zinc-200 hover:bg-black/30'
                    }
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium break-all">{r.id}</div>
                      <div className="text-[11px] text-zinc-400">{r.kind} · {r.status}</div>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">profile: {r.modelProfile}</div>
                    {r.parentRunId ? <div className="mt-1 break-all text-[10px] text-zinc-500">parent: {r.parentRunId}</div> : null}
                  </button>
                ))}

                {selectedRunId ? (
                  <button
                    onClick={() => router.push(`${BASE}/runs/${encodeURIComponent(selectedRunId)}`)}
                    className="w-full rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
                  >
                    Open selected run
                  </button>
                ) : null}
              </div>
            </div>

            <div className="md:col-span-3">
              {selectedRunId ? (
                <RunTimeline runId={selectedRunId} />
              ) : (
                <div className="rounded-xl border border-matrix-500/20 bg-black/25 p-3 text-sm text-zinc-300">Select a run.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
