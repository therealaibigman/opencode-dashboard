'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';
import { useProject } from './ProjectContext';
import { RunTimeline } from './RunTimeline';

type TaskStatus = 'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';

type Task = {
  id: string;
  title: string;
  bodyMd: string;
  status: TaskStatus;
};

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

export function TaskDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const BASE = useBasePath();
  const { selectedProjectId: projectId } = useProject();

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const api = useMemo(
    () => ({
      runs: `${BASE}/api/runs`
    }),
    [BASE]
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
            <div>
              <div className="text-xs text-zinc-400">Task</div>
              <div className="text-lg font-semibold text-matrix-100">{task.title}</div>
              <div className="mt-1 text-xs text-zinc-400">{task.id} · {task.status}</div>
              {task.bodyMd ? <div className="mt-2 text-sm text-zinc-200">{task.bodyMd}</div> : null}
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

              {err ? <div className="rounded-lg border border-red-500/30 bg-red-950/30 p-2 text-xs text-red-100">{err}</div> : null}

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
                      <div className="font-medium">{r.id}</div>
                      <div className="text-[11px] text-zinc-400">{r.status}</div>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">profile: {r.modelProfile}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="md:col-span-3">
              {selectedRunId ? <RunTimeline runId={selectedRunId} /> : (
                <div className="rounded-xl border border-matrix-500/20 bg-black/25 p-3 text-sm text-zinc-300">
                  Select a run.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
