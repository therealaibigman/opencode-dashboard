'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useBasePath } from './useBasePath';
import { useSettings } from './useSettings';
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
  const { settings } = useSettings();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const api = useMemo(
    () => ({
      tasks: `${BASE}/api/tasks`,
      runs: `${BASE}/api/runs`,
      threads: `${BASE}/api/threads`,
      messages: (threadId: string) => `${BASE}/api/threads/${encodeURIComponent(threadId)}/messages`
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

  async function createThread({ taskId }: { taskId?: string | null }) {
    const res = await fetch(api.threads, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, task_id: taskId ?? null, title: taskId ? 'Task thread' : 'Project thread' })
    });
    const data = await j<{ thread: { id: string } }>(res);
    return data.thread.id;
  }

  async function appendUserMessage({ threadId, content }: { threadId: string; content: string }) {
    await j(
      await fetch(api.messages(threadId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'user', content_md: content })
      })
    );
  }

  async function queueRun({ taskId, kind, threadId }: { taskId?: string; kind: 'execute' | 'plan'; threadId?: string }) {
    const res = await fetch(api.runs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        task_id: taskId ?? null,
        thread_id: threadId ?? null,
        model_profile: settings.modelProfile || 'balanced',
        kind
      })
    });
    const data = await j<{ run: { id: string } }>(res);
    setLog((p) => [`Queued ${kind} run ${data.run.id} (task: ${taskId ?? 'none'})`, ...p]);
    router.push(`/runs/${encodeURIComponent(data.run.id)}`);
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
                const taskId = await createTask();
                const threadId = await createThread({ taskId });
                await appendUserMessage({ threadId, content: `${title || 'Untitled task'}\n\n${body}`.trim() });
                setTitle('');
                setBody('');
                setLog((p) => [`Created thread ${threadId} for task ${taskId}`, ...p]);
              }}
              className="rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40 hover:bg-matrix-500/20"
            >
              Create Task
            </button>

            <button
              onClick={async () => {
                const taskId = await createTask();
                const threadId = await createThread({ taskId });
                await appendUserMessage({ threadId, content: `${title || 'Untitled task'}\n\n${body}`.trim() });
                setTitle('');
                setBody('');
                await queueRun({ taskId, kind: 'plan', threadId });
              }}
              className="rounded-lg bg-blue-500/20 px-3 py-2 text-sm font-medium text-blue-50 ring-1 ring-blue-500/40 hover:bg-blue-500/25"
            >
              Plan
            </button>

            <button
              onClick={async () => {
                const taskId = await createTask();
                const threadId = await createThread({ taskId });
                await appendUserMessage({ threadId, content: `${title || 'Untitled task'}\n\n${body}`.trim() });
                setTitle('');
                setBody('');
                await queueRun({ taskId, kind: 'execute', threadId });
              }}
              className="rounded-lg bg-matrix-500/25 px-3 py-2 text-sm font-medium text-matrix-50 ring-1 ring-matrix-500/50 hover:bg-matrix-500/30"
            >
              Execute
            </button>

            <button
              onClick={async () => {
                const threadId = await createThread({ taskId: null });
                await appendUserMessage({ threadId, content: `${title || 'Idea'}\n\n${body}`.trim() });
                setTitle('');
                setBody('');
                await queueRun({ kind: 'plan', threadId });
              }}
              className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
            >
              Plan (no task)
            </button>
          </div>

          <div className="rounded-xl border border-matrix-500/20 bg-black/20 p-3">
            <div className="mb-2 text-xs font-medium text-matrix-200/90">Log</div>
            {log.length === 0 ? <div className="text-[11px] text-zinc-400">No actions yet.</div> : null}
            <div className="space-y-1">
              {log.slice(0, 10).map((l, i) => (
                <div key={i} className="text-[11px] text-zinc-300">
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-matrix-500/20 bg-black/20 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Live events</div>
          <EventFeed />
        </div>
      </div>
    </div>
  );
}
