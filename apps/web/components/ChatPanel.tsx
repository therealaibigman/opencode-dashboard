'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useBasePath } from './useBasePath';
import { useProject } from './ProjectContext';
import { EventFeed } from './EventFeed';

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export function ChatPanel() {
  const BASE = useBasePath();
  const router = useRouter();
  const { selectedProjectId: projectId } = useProject();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const api = useMemo(
    () => ({
      tasks: `${BASE}/api/tasks`,
      runs: `${BASE}/api/runs`
    }),
    [BASE]
  );

  async function createTask() {
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
    return data.task.id;
  }

  async function queueRun({ taskId, kind }: { taskId?: string; kind: 'execute' | 'plan' }) {
    const res = await fetch(api.runs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, task_id: taskId ?? null, model_profile: 'balanced', kind })
    });
    const data = await j<{ run: { id: string } }>(res);
    setLog((p) => [`Queued ${kind} run ${data.run.id} (task: ${taskId ?? 'none'})`, ...p]);
    router.push(`${BASE}/runs/${encodeURIComponent(data.run.id)}`);
    return data.run.id;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-matrix-500/20 bg-black/20 p-3 text-xs text-zinc-300">
        Project: <span className="text-zinc-100">{projectId}</span>
      </div>

      <div className="grid items-stretch gap-3 md:grid-cols-2">
        <div className="space-y-3">
          <div className="grid gap-3">
            <div className="space-y-2">
              <div className="text-xs text-zinc-300">Feature idea / Task title</div>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Add caching to /api/runs"
                className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
              />
            </div>
            <div className="space-y-2">
              <div className="text-xs text-zinc-300">Details / acceptance criteria (optional)</div>
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
                await createTask();
                setTitle('');
                setBody('');
              }}
              className="rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40 hover:bg-matrix-500/20"
            >
              Create Task
            </button>

            <button
              onClick={async () => {
                const taskId = await createTask();
                setTitle('');
                setBody('');
                await queueRun({ taskId, kind: 'plan' });
              }}
              className="rounded-lg bg-blue-500/20 px-3 py-2 text-sm font-medium text-blue-50 ring-1 ring-blue-500/40 hover:bg-blue-500/25"
            >
              Plan
            </button>

            <button
              onClick={async () => {
                const taskId = await createTask();
                setTitle('');
                setBody('');
                await queueRun({ taskId, kind: 'execute' });
              }}
              className="rounded-lg bg-matrix-500/25 px-3 py-2 text-sm font-medium text-matrix-50 ring-1 ring-matrix-500/50 hover:bg-matrix-500/30"
            >
              Execute
            </button>

            <button
              onClick={async () => queueRun({ kind: 'plan' })}
              className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
            >
              Plan (no task)
            </button>
          </div>

          <div className="rounded-xl border border-matrix-500/20 bg-black/25 p-3">
            <div className="mb-2 text-xs font-medium text-matrix-200/90">Local actions log</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-200">
              {log.join('\n')}
            </pre>
          </div>
        </div>

        <EventFeed className="min-h-[620px] md:min-h-[calc(100vh-240px)]" />
      </div>
    </div>
  );
}
