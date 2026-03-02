'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';

type TaskStatus = 'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';

type Task = {
  id: string;
  projectId: string;
  title: string;
  bodyMd: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
};

const COLS: { key: TaskStatus; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'planned', label: 'Planned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' }
];

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

function nextStatus(s: TaskStatus, dir: -1 | 1): TaskStatus {
  const idx = COLS.findIndex((c) => c.key === s);
  const n = Math.max(0, Math.min(COLS.length - 1, idx + dir));
  return COLS[n]!.key;
}

export function KanbanPanel() {
  const BASE = useBasePath();
  const [projectId, setProjectId] = useState('prj_demo');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const api = useMemo(
    () => ({
      tasks: `${BASE}/api/tasks`,
      patchTask: (id: string) => `${BASE}/api/tasks/${encodeURIComponent(id)}`,
      runs: `${BASE}/api/runs`
    }),
    [BASE]
  );

  async function refresh() {
    setErr(null);
    try {
      const data = await j<{ tasks: Task[] }>(
        await fetch(`${api.tasks}?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' })
      );
      setTasks(data.tasks);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function moveTask(t: Task, dir: -1 | 1) {
    const to = nextStatus(t.status, dir);
    await fetch(api.patchTask(t.id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: to })
    });
    await refresh();
  }

  async function queueRun(t: Task) {
    await fetch(api.runs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, task_id: t.id, model_profile: 'balanced' })
    });
  }

  const by = COLS.reduce((acc, c) => {
    acc[c.key] = [];
    return acc;
  }, {} as Record<TaskStatus, Task[]>);

  for (const t of tasks) by[t.status]?.push(t);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Project</div>
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
          >
            Refresh
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">
          {err}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-6">
        {COLS.map((c) => (
          <div key={c.key} className="rounded-xl border border-matrix-500/15 bg-black/15 p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-medium text-matrix-200/90">{c.label}</div>
              <div className="text-[11px] text-zinc-400">{by[c.key]?.length ?? 0}</div>
            </div>

            <div className="space-y-2">
              {(by[c.key] ?? []).map((t) => (
                <div
                  key={t.id}
                  className="rounded-lg border border-matrix-500/15 bg-black/30 p-2 text-xs text-zinc-200"
                >
                  <div className="mb-1 line-clamp-2 text-sm text-zinc-100">{t.title}</div>
                  {t.bodyMd ? <div className="mb-2 text-[11px] text-zinc-400">{t.bodyMd}</div> : null}

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => moveTask(t, -1)}
                      className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
                      title="Move left"
                    >
                      ←
                    </button>
                    <button
                      onClick={() => moveTask(t, 1)}
                      className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
                      title="Move right"
                    >
                      →
                    </button>
                    <button
                      onClick={() => queueRun(t)}
                      className="rounded-md bg-matrix-500/15 px-2 py-1 text-[11px] text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20"
                    >
                      Queue run
                    </button>
                  </div>

                  <div className="mt-2 text-[10px] text-zinc-500">{t.id}</div>
                </div>
              ))}

              {(by[c.key] ?? []).length === 0 ? (
                <div className="rounded-lg border border-matrix-500/10 bg-black/20 p-2 text-[11px] text-zinc-400">
                  Empty
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
