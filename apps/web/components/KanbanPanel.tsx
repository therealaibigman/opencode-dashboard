'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { useBasePath } from './useBasePath';
import { useSettings } from './useSettings';
import { useProject } from './ProjectContext';
import { TaskDrawer } from './TaskDrawer';

type TaskStatus = 'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';

type Task = {
  id: string;
  projectId: string;
  title: string;
  bodyMd: string;
  status: TaskStatus;
  position: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type RunSummary = {
  id: string;
  taskId: string | null;
  kind: 'execute' | 'plan' | 'review' | 'publish';
  status: string;
  prUrl: string | null;
  createdAt: string;
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

function taskIdToDndId(taskId: string) {
  return `task:${taskId}`;
}

function dndIdToTaskId(dndId: string) {
  return dndId.startsWith('task:') ? dndId.slice('task:'.length) : null;
}

function colId(status: TaskStatus) {
  return `col:${status}`;
}

function parseColId(id: string): TaskStatus | null {
  if (!id.startsWith('col:')) return null;
  return id.slice('col:'.length) as TaskStatus;
}

function sortInCol(ts: Task[]) {
  return [...ts].sort((a, b) => {
    const ap = Number.isFinite(a.position) ? a.position : 0;
    const bp = Number.isFinite(b.position) ? b.position : 0;
    if (ap !== bp) return ap - bp;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

function posBetween(prev: number | null, next: number | null) {
  if (prev === null && next === null) return 0;
  if (prev === null) return (next ?? 0) - 1;
  if (next === null) return (prev ?? 0) + 1;
  if (prev === next) return prev + 1;
  return prev + (next - prev) / 2;
}

function statusDot(status: string) {
  if (status === 'succeeded') return 'bg-matrix-400';
  if (status === 'failed') return 'bg-red-400';
  if (status === 'needs_approval') return 'bg-yellow-400';
  if (status === 'running') return 'bg-blue-400';
  return 'bg-zinc-400';
}

function TaskCard({
  t,
  run,
  onOpen,
  onMoveLeft,
  onMoveRight,
  onQueue
}: {
  t: Task;
  run: RunSummary | null;
  onOpen: () => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onQueue: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: taskIdToDndId(t.id)
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={
        isDragging
          ? 'min-w-0 rounded-lg border border-matrix-500/30 bg-black/40 p-2 text-xs text-zinc-200 opacity-70'
          : 'min-w-0 rounded-lg border border-matrix-500/15 bg-black/30 p-2 text-xs text-zinc-200'
      }
    >
      <button onClick={onOpen} className="block w-full min-w-0 text-left">
        <div className="mb-1 min-w-0 line-clamp-2 break-words text-sm text-zinc-100 hover:underline">{t.title}</div>
        {t.bodyMd ? (
          <div className="mb-2 min-w-0 line-clamp-3 break-words text-[11px] text-zinc-400">{t.bodyMd}</div>
        ) : null}
      </button>

      {run ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-300">
          <span className={`h-2 w-2 rounded-full ${statusDot(run.status)}`} title={run.status} />
          <span className="rounded-full bg-black/20 px-2 py-1 ring-1 ring-matrix-500/10">{run.kind}</span>
          <span className="break-all text-zinc-400">{run.id}</span>
          {run.status === 'needs_approval' ? (
            <span className="rounded-full bg-yellow-500/10 px-2 py-1 text-yellow-100 ring-1 ring-yellow-500/25">needs approval</span>
          ) : null}
          {run.prUrl ? (
            <a
              href={run.prUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="ml-auto rounded-full bg-matrix-500/15 px-2 py-1 text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20"
            >
              PR
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onMoveLeft}
          className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
          title="Move left"
        >
          ←
        </button>
        <button
          onClick={onMoveRight}
          className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35"
          title="Move right"
        >
          →
        </button>
        <button
          onClick={onQueue}
          className="rounded-md bg-matrix-500/15 px-2 py-1 text-[11px] text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20"
        >
          Queue run
        </button>

        <button
          {...attributes}
          {...listeners}
          className="ml-auto cursor-grab rounded-md bg-black/25 px-2 py-1 text-[11px] text-zinc-200 ring-1 ring-matrix-500/15 hover:bg-black/35 active:cursor-grabbing"
          title="Drag"
        >
          ⠿
        </button>
      </div>

      <div className="mt-2 min-w-0 break-all text-[10px] text-zinc-500">{t.id}</div>
    </div>
  );
}

export function KanbanPanel() {
  const BASE = useBasePath();
  const router = useRouter();
  const { selectedProjectId: projectId } = useProject();
  const { settings } = useSettings();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [archived, setArchived] = useState<Task[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  const [runsByTask, setRunsByTask] = useState<Record<string, RunSummary>>({});

  const [err, setErr] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const refreshing = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const api = useMemo(
    () => ({
      tasks: `${BASE}/api/tasks`,
      patchTask: (id: string) => `${BASE}/api/tasks/${encodeURIComponent(id)}`,
      runs: `${BASE}/api/runs`,
      projectEvents: (pid: string) => `${BASE}/api/projects/${encodeURIComponent(pid)}/events/stream`
    }),
    [BASE]
  );

  async function refreshRunsSummary() {
    try {
      const data = await j<{ runs: any[] }>(
        await fetch(`${api.runs}?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' })
      );

      const map: Record<string, RunSummary> = {};
      for (const r of data.runs ?? []) {
        const tid = r.taskId ?? null;
        if (!tid) continue;
        if (!map[tid]) {
          map[tid] = {
            id: r.id,
            taskId: r.taskId,
            kind: r.kind,
            status: r.status,
            prUrl: r.prUrl ?? null,
            createdAt: r.createdAt
          };
        }
      }
      setRunsByTask(map);
    } catch {
      // ignore
    }
  }

  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;

    setErr(null);
    try {
      const data = await j<{ tasks: Task[] }>(
        await fetch(`${api.tasks}?project_id=${encodeURIComponent(projectId)}&include_archived=1`, {
          cache: 'no-store'
        })
      );

      const active = (data.tasks ?? []).filter((t) => !t.archivedAt);
      const arc = (data.tasks ?? []).filter((t) => Boolean(t.archivedAt));

      setTasks(active);
      setArchived(arc);
      setLastSync(Date.now());

      await refreshRunsSummary();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      refreshing.current = false;
    }
  }

  function refreshDebounced() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      refresh().catch(() => void 0);
    }, 150);
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    setErr(null);
    const es = new EventSource(api.projectEvents(projectId));

    const onAny = () => {
      refreshDebounced();
    };

    const types = [
      'task.created',
      'task.updated',
      'task.status.changed',
      'task.archived.changed',
      'run.created',
      'run.started',
      'run.completed',
      'run.failed',
      'approval.requested',
      'approval.resolved',
      'tool.call.completed',
      'tool.call.failed'
    ];
    for (const t of types) es.addEventListener(t, onAny);

    es.onerror = () => {
      setErr('SSE disconnected (project stream). Check nginx buffering/timeouts.');
    };

    return () => {
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, api.projectEvents]);

  async function patchTask(taskId: string, patch: Partial<Pick<Task, 'status' | 'position'>> & { archived?: boolean }) {
    await fetch(api.patchTask(taskId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    });
  }

  async function moveTask(t: Task, dir: -1 | 1) {
    const to = nextStatus(t.status, dir);
    const tasksInTo = sortInCol(tasks.filter((x) => x.status === to));
    const last = tasksInTo.length ? tasksInTo[tasksInTo.length - 1]!.position : 0;
    await patchTask(t.id, { status: to, position: last + 1 });
    refreshDebounced();
  }

  async function queueRun(t: Task) {
    setErr(null);
    try {
      const res = await fetch(api.runs, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, task_id: t.id, model_profile: settings.modelProfile || 'balanced' })
      });
      const data = await j<{ run: { id: string } }>(res);
      router.push(`/runs/${encodeURIComponent(data.run.id)}`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }

  async function restoreTask(t: Task) {
    await patchTask(t.id, { archived: false, status: 'inbox', position: 0 });
    refreshDebounced();
  }

  const by = COLS.reduce((acc, c) => {
    acc[c.key] = [];
    return acc;
  }, {} as Record<TaskStatus, Task[]>);

  for (const t of tasks) by[t.status]?.push(t);
  for (const k of Object.keys(by) as TaskStatus[]) by[k] = sortInCol(by[k]);

  const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) ?? null : null;

  async function onDragEnd(ev: DragEndEvent) {
    setActiveTaskId(null);

    const activeId = String(ev.active.id);
    const overId = ev.over ? String(ev.over.id) : null;

    const tid = dndIdToTaskId(activeId);
    if (!tid || !overId) return;

    const moving = tasks.find((x) => x.id === tid);
    if (!moving) return;

    // Dropped over a column -> move to end of that column.
    const overCol = parseColId(overId);
    if (overCol) {
      const toCol = overCol;
      const colTasks = sortInCol(tasks.filter((x) => x.status === toCol && x.id !== tid));
      const last = colTasks.length ? colTasks[colTasks.length - 1]!.position : 0;
      const newPos = last + 1;

      setTasks((prev) => prev.map((x) => (x.id === tid ? { ...x, status: toCol, position: newPos } : x)));
      try {
        await patchTask(tid, { status: toCol, position: newPos });
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      } finally {
        refreshDebounced();
      }
      return;
    }

    const overTid = dndIdToTaskId(overId);
    if (!overTid) return;

    const over = tasks.find((x) => x.id === overTid);
    if (!over) return;

    const toCol = over.status;

    // Build target column list excluding moving task.
    const colTasks = sortInCol(tasks.filter((x) => x.status === toCol && x.id !== tid));
    const overIndex = colTasks.findIndex((x) => x.id === overTid);
    if (overIndex < 0) return;

    // Determine insertion index (place before the hovered card).
    const insertIndex = overIndex;
    const prev = insertIndex > 0 ? colTasks[insertIndex - 1]!.position : null;
    const next = colTasks[insertIndex] ? colTasks[insertIndex]!.position : null;
    const newPos = posBetween(prev, next);

    setTasks((prevTasks) =>
      prevTasks.map((x) => (x.id === tid ? { ...x, status: toCol, position: newPos } : x))
    );

    try {
      await patchTask(tid, { status: toCol, position: newPos });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      refreshDebounced();
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <div className="text-xs text-zinc-300">Project</div>
          <div className="rounded-lg border border-matrix-500/20 bg-black/25 px-3 py-2 text-sm text-zinc-100">{projectId}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => refresh()}
            className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
          >
            Refresh
          </button>

          <label className="flex items-center gap-2 rounded-lg bg-black/15 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/15">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived ({archived.length})
          </label>

          <div className="text-xs text-zinc-500">
            {lastSync ? `Synced ${Math.floor((Date.now() - lastSync) / 1000)}s ago` : 'Not synced yet'}
          </div>
        </div>
      </div>

      {err && <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">{err}</div>}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(ev) => {
          const tid = dndIdToTaskId(String(ev.active.id));
          setActiveTaskId(tid);
        }}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-3 md:grid-cols-6">
          {COLS.map((c) => {
            const tasksInCol = by[c.key] ?? [];
            return (
              <div key={c.key} id={colId(c.key)} className="rounded-xl border border-matrix-500/15 bg-black/15 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-medium text-matrix-200/90">{c.label}</div>
                  <div className="text-[11px] text-zinc-400">{tasksInCol.length}</div>
                </div>

                <SortableContext items={tasksInCol.map((t) => taskIdToDndId(t.id))} strategy={verticalListSortingStrategy}>
                  <div id={colId(c.key)} className="space-y-2">
                    {tasksInCol.map((t) => (
                      <TaskCard
                        key={t.id}
                        t={t}
                        run={runsByTask[t.id] ?? null}
                        onOpen={() => setOpenTask(t)}
                        onMoveLeft={() => moveTask(t, -1)}
                        onMoveRight={() => moveTask(t, 1)}
                        onQueue={() => queueRun(t)}
                      />
                    ))}

                    {tasksInCol.length === 0 ? (
                      <div className="rounded-lg border border-matrix-500/10 bg-black/20 p-2 text-[11px] text-zinc-400">Empty</div>
                    ) : null}
                  </div>
                </SortableContext>
              </div>
            );
          })}
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="min-w-0 rounded-lg border border-matrix-500/30 bg-black/50 p-2 text-xs text-zinc-200">
              <div className="min-w-0 break-words text-sm font-medium text-zinc-100">{activeTask.title}</div>
              {activeTask.bodyMd ? <div className="mt-1 line-clamp-3 break-words text-[11px] text-zinc-400">{activeTask.bodyMd}</div> : null}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {showArchived ? (
        <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Archived</div>
          {archived.length === 0 ? <div className="text-[11px] text-zinc-400">No archived tasks.</div> : null}
          <div className="space-y-2">
            {archived.map((t) => (
              <div
                key={t.id}
                className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-matrix-500/10 bg-black/20 p-3"
              >
                <button className="min-w-0 text-left" onClick={() => setOpenTask(t)}>
                  <div className="min-w-0 break-words text-sm font-medium text-zinc-100">{t.title}</div>
                  <div className="mt-1 break-all text-[10px] text-zinc-500">{t.id}</div>
                </button>

                <button
                  onClick={() => restoreTask(t)}
                  className="shrink-0 rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20"
                >
                  Restore to inbox
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {openTask ? (
        <TaskDrawer
          task={{
            id: openTask.id,
            title: openTask.title,
            bodyMd: openTask.bodyMd,
            status: openTask.status,
            archivedAt: openTask.archivedAt
          }}
          onClose={() => setOpenTask(null)}
        />
      ) : null}
    </div>
  );
}
