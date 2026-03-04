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

type ThreadRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type MessageRow = {
  id: string;
  projectId: string;
  threadId: string;
  role: string;
  contentMd: string;
  createdAt: string;
};

type RunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  parentRunId: string | null;
  threadId: string | null;
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

function fmtTs(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { hour12: false });
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

  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [newThreadTitle, setNewThreadTitle] = useState('');
  const [newMsg, setNewMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);

  const [err, setErr] = useState<string | null>(null);
  const [queueing, setQueueing] = useState<'plan' | 'execute' | null>(null);

  const api = useMemo(
    () => ({
      runs: `${BASE}/api/runs`,
      task: `${BASE}/api/tasks/${encodeURIComponent(task.id)}`,
      threads: `${BASE}/api/threads`,
      messages: (threadId: string) => `${BASE}/api/threads/${encodeURIComponent(threadId)}/messages`
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

  async function refreshThreads() {
    setErr(null);
    try {
      const data = await j<{ threads: ThreadRow[] }>(
        await fetch(
          `${api.threads}?project_id=${encodeURIComponent(projectId)}&task_id=${encodeURIComponent(task.id)}`,
          { cache: 'no-store' }
        )
      );
      setThreads(data.threads);
      if (!selectedThreadId && data.threads.length) setSelectedThreadId(data.threads[0]!.id);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function refreshMessages(threadId: string) {
    try {
      const data = await j<{ messages: MessageRow[] }>(await fetch(api.messages(threadId), { cache: 'no-store' }));
      setMessages(data.messages);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function ensureDefaultThread() {
    if (threads.length) return;
    // create a default thread for this task
    setCreatingThread(true);
    try {
      const res = await fetch(api.threads, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, task_id: task.id, title: 'Task thread' })
      });
      const data = await j<{ thread: { id: string } }>(res);
      await refreshThreads();
      setSelectedThreadId(data.thread.id);
    } finally {
      setCreatingThread(false);
    }
  }

  async function createThread() {
    const t = newThreadTitle.trim() || 'New thread';
    setCreatingThread(true);
    setErr(null);
    try {
      const res = await fetch(api.threads, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, task_id: task.id, title: t })
      });
      const data = await j<{ thread: { id: string } }>(res);
      setNewThreadTitle('');
      await refreshThreads();
      setSelectedThreadId(data.thread.id);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setCreatingThread(false);
    }
  }

  async function sendMessage() {
    const tid = selectedThreadId;
    if (!tid) return;
    const content = newMsg.trim();
    if (!content) return;

    setSending(true);
    setErr(null);
    try {
      await j(
        await fetch(api.messages(tid), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'user', content_md: content })
        })
      );
      setNewMsg('');
      await refreshMessages(tid);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSending(false);
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

  async function queue(kind: 'plan' | 'execute', parentRunId?: string | null) {
    setErr(null);
    setQueueing(kind);
    try {
      let tid = selectedThreadId;
      if (!tid) {
        await refreshThreads();
        await ensureDefaultThread();
        tid = selectedThreadId;
      }

      const res = await fetch(api.runs, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          task_id: task.id,
          thread_id: tid,
          model_profile: 'balanced',
          kind,
          parent_run_id: parentRunId ?? null
        })
      });
      const data = await j<{ run: { id: string } }>(res);
      setSelectedRunId(data.run.id);
      router.push(`/runs/${encodeURIComponent(data.run.id)}`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setQueueing(null);
    }
  }

  const latestPlan = runs.find((r) => r.kind === 'plan') ?? null;
  const latestExec = runs.find((r) => r.kind === 'execute') ?? null;

  useEffect(() => {
    void refreshRuns();
    void refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, projectId]);

  useEffect(() => {
    if (!selectedThreadId) return;
    void refreshMessages(selectedThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId]);

  useEffect(() => {
    if (!threads.length) return;
    if (!selectedThreadId) setSelectedThreadId(threads[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads.length]);

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
                  onClick={async () => {
                    await refreshThreads();
                    if (selectedThreadId) await refreshMessages(selectedThreadId);
                    await refreshRuns();
                  }}
                  className="rounded-lg bg-black/20 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/30"
                >
                  Refresh
                </button>
              </div>

              {latestExec?.prUrl ? (
                <div className="mt-2 text-xs text-zinc-200">
                  Latest PR:{' '}
                  <a
                    className="break-all text-matrix-200/90 hover:underline"
                    href={latestExec.prUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
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

          <div className="grid flex-1 gap-3 overflow-hidden p-4 md:grid-cols-5">
            <div className="md:col-span-2 space-y-3 overflow-hidden">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-medium text-matrix-200/90">Threads</div>
                  <button
                    onClick={() => refreshThreads()}
                    className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
                  >
                    Refresh
                  </button>
                </div>

                <div className="flex gap-2">
                  <input
                    value={newThreadTitle}
                    onChange={(e) => setNewThreadTitle(e.target.value)}
                    placeholder="New thread title"
                    className="w-full rounded-lg border border-matrix-500/20 bg-black/25 px-2 py-2 text-xs text-zinc-100 outline-none"
                  />
                  <button
                    onClick={() => createThread()}
                    disabled={creatingThread}
                    className="shrink-0 rounded-lg bg-matrix-500/15 px-3 py-2 text-xs text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20 disabled:opacity-60"
                  >
                    {creatingThread ? '…' : 'New'}
                  </button>
                </div>

                <div className="mt-2 max-h-48 space-y-2 overflow-auto pr-1">
                  {threads.length === 0 ? (
                    <div className="rounded-lg border border-matrix-500/10 bg-black/20 p-2 text-[11px] text-zinc-400">
                      No threads yet.
                    </div>
                  ) : null}

                  {threads.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setSelectedThreadId(t.id)}
                      className={
                        selectedThreadId === t.id
                          ? 'w-full rounded-lg border border-matrix-500/30 bg-matrix-500/10 p-2 text-left text-xs text-zinc-100'
                          : 'w-full rounded-lg border border-matrix-500/10 bg-black/20 p-2 text-left text-xs text-zinc-200 hover:bg-black/30'
                      }
                    >
                      <div className="break-all font-medium">{t.title || t.id}</div>
                      <div className="mt-1 break-all text-[10px] text-zinc-500">{t.id}</div>
                      <div className="mt-1 text-[10px] text-zinc-500">updated: {fmtTs(t.updatedAt)}</div>
                    </button>
                  ))}
                </div>
                {selectedThreadId ? (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={threads.find((x) => x.id === selectedThreadId)?.title ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setThreads((prev) => prev.map((t) => (t.id === selectedThreadId ? { ...t, title: v } : t)));
                      }}
                      className="w-full rounded-lg border border-matrix-500/20 bg-black/25 px-2 py-2 text-xs text-zinc-100 outline-none"
                      placeholder="Thread title"
                    />
                    <button
                      onClick={async () => {
                        const t = threads.find((x) => x.id === selectedThreadId);
                        if (!t) return;
                        await fetch(`${BASE}/api/threads/${encodeURIComponent(selectedThreadId)}`, {
                          method: 'PATCH',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ title: t.title })
                        });
                        await refreshThreads();
                      }}
                      className="shrink-0 rounded-lg bg-black/25 px-3 py-2 text-xs text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
                    >
                      Save title
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-matrix-500/15 bg-black/15 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-medium text-matrix-200/90">Messages</div>
                  {selectedThreadId ? (
                    <div className="text-[10px] text-zinc-500 break-all">{selectedThreadId}</div>
                  ) : null}
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-auto pr-1">
                  {selectedThreadId && messages.length === 0 ? (
                    <div className="text-[11px] text-zinc-400">No messages yet.</div>
                  ) : null}
                  {!selectedThreadId ? <div className="text-[11px] text-zinc-400">Select a thread.</div> : null}

                  {messages.map((m) => (
                    <div key={m.id} className="rounded-lg border border-matrix-500/10 bg-black/20 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] text-zinc-300">{m.role}</div>
                        <div className="text-[10px] text-zinc-500">{fmtTs(m.createdAt)}</div>
                      </div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-100">{m.contentMd}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-2 flex gap-2">
                  <input
                    value={newMsg}
                    onChange={(e) => setNewMsg(e.target.value)}
                    placeholder="Write a message…"
                    className="w-full rounded-lg border border-matrix-500/20 bg-black/25 px-2 py-2 text-xs text-zinc-100 outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        void sendMessage();
                      }
                    }}
                  />
                  <button
                    onClick={() => sendMessage()}
                    disabled={sending || !selectedThreadId}
                    className="shrink-0 rounded-lg bg-matrix-500/15 px-3 py-2 text-xs text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20 disabled:opacity-60"
                  >
                    {sending ? '…' : 'Send'}
                  </button>
                </div>
                <div className="mt-1 text-[10px] text-zinc-500">Ctrl/Cmd+Enter to send</div>
              </div>
            </div>

            <div className="md:col-span-3 min-h-0 overflow-hidden">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-medium text-matrix-200/90">Runs</div>
                <button
                  onClick={() => refreshRuns()}
                  className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
                >
                  Refresh
                </button>
              </div>

              <div className="space-y-2 overflow-auto pr-1">
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
                      <div className="text-[11px] text-zinc-400">
                        {r.kind} · {r.status}
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">profile: {r.modelProfile}</div>
                    {r.parentRunId ? <div className="mt-1 break-all text-[10px] text-zinc-500">parent: {r.parentRunId}</div> : null}
                    {r.threadId ? <div className="mt-1 break-all text-[10px] text-zinc-500">thread: {r.threadId}</div> : null}
                  </button>
                ))}

                {selectedRunId ? (
                  <button
                    onClick={() => router.push(`/runs/${encodeURIComponent(selectedRunId)}`)}
                    className="w-full rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
                  >
                    Open selected run
                  </button>
                ) : null}
              </div>

              <div className="mt-3">
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
    </div>
  );
}
