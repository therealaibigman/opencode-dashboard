'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';

type Project = { id: string; name: string };

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export function ChatPanel() {
  const BASE = useBasePath();

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('prj_demo');

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const api = useMemo(
    () => ({
      projects: `${BASE}/api/projects`,
      tasks: `${BASE}/api/tasks`,
      runs: `${BASE}/api/runs`
    }),
    [BASE]
  );

  useEffect(() => {
    (async () => {
      try {
        const data = await j<{ projects: Project[] }>(await fetch(api.projects, { cache: 'no-store' }));
        setProjects(data.projects);
      } catch (e: any) {
        setLog((p) => [`Failed loading projects: ${String(e?.message ?? e)}`, ...p]);
      }
    })();
  }, [api.projects]);

  async function ensureDemoProject() {
    const res = await fetch(api.projects, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'prj_demo', name: 'Demo' })
    });
    await j(res);
    const data = await j<{ projects: Project[] }>(await fetch(api.projects, { cache: 'no-store' }));
    setProjects(data.projects);
    setProjectId('prj_demo');
  }

  async function queueRunForTask(taskId?: string) {
    const res = await fetch(api.runs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, task_id: taskId ?? null, model_profile: 'balanced' })
    });
    const data = await j<{ run: { id: string } }>(res);
    setLog((p) => [`Queued run ${data.run.id} (task: ${taskId ?? 'none'})`, ...p]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Project</div>
          <div className="flex items-center gap-2">
            <select
              className="rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
              {!projects.find((p) => p.id === projectId) && (
                <option value={projectId}>{projectId}</option>
              )}
            </select>
            <button
              onClick={ensureDemoProject}
              className="rounded-lg bg-matrix-500/10 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/15"
            >
              Ensure Demo Project
            </button>
          </div>
        </div>

        <div className="text-xs text-zinc-400">
          basePath: <span className="text-zinc-200">{BASE || '(none)'}</span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Message / Task title</div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Add caching to /api/runs"
            className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
          />
        </div>
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Details (optional)</div>
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Acceptance criteria, context, links…"
            className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={async () => {
            const res = await fetch(api.tasks, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                project_id: projectId,
                title: title || 'Untitled task',
                body_md: body,
                status: 'inbox'
              })
            });
            const data = await j<{ task: { id: string } }>(res);
            setLog((p) => [`Created task ${data.task.id}`, ...p]);
            setTitle('');
            setBody('');
          }}
          className="rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40 hover:bg-matrix-500/20"
        >
          Create Task
        </button>
        <button
          onClick={async () => {
            const res = await fetch(api.tasks, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ project_id: projectId, title: title || 'Untitled task', body_md: body, status: 'inbox' })
            });
            const data = await j<{ task: { id: string } }>(res);
            setLog((p) => [`Created task ${data.task.id}`, ...p]);
            setTitle('');
            setBody('');
            await queueRunForTask(data.task.id);
          }}
          className="rounded-lg bg-matrix-500/25 px-3 py-2 text-sm font-medium text-matrix-50 ring-1 ring-matrix-500/50 hover:bg-matrix-500/30"
        >
          Create + Queue Run
        </button>
        <button
          onClick={async () => queueRunForTask(undefined)}
          className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
        >
          Queue Run (no task)
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-matrix-500/20 bg-black/25 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">What this is</div>
          <div className="text-xs text-zinc-300">
            This “chat” tab is the control surface. It creates a task + optionally queues a run.
          </div>
        </div>

        <div className="rounded-xl border border-matrix-500/20 bg-black/25 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Log</div>
          <pre className="max-h-40 overflow-auto text-xs text-zinc-200">{log.join('\n')}</pre>
        </div>
      </div>
    </div>
  );
}
