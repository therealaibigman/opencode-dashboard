'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';
import { useProject } from './ProjectContext';
import type { OcdashEvent } from '@ocdash/shared';

function fmtTs(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

function summarisePayload(payload: any): string {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (payload.message) return String(payload.message);
  if (payload.task?.title) return String(payload.task.title);
  if (payload.run?.id) return `run ${payload.run.id}`;
  if (payload.task_id && payload.status) return `task ${payload.task_id} -> ${payload.status}`;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function EventFeed({ max = 200 }: { max?: number }) {
  const BASE = useBasePath();
  const { selectedProjectId: projectId } = useProject();

  const [events, setEvents] = useState<OcdashEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');

  const url = useMemo(
    () => `${BASE}/api/projects/${encodeURIComponent(projectId)}/events/stream`,
    [BASE, projectId]
  );

  useEffect(() => {
    setEvents([]);
    setStatus('connecting');

    const es = new EventSource(url);

    const onAny = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as OcdashEvent;
        setEvents((prev) => [e, ...prev].slice(0, max));
      } catch {
        // ignore
      }
    };

    // We don't know the full universe here, so listen to onmessage AND a few known types.
    es.onmessage = onAny;
    const known = [
      'task.created',
      'task.updated',
      'task.status.changed',
      'run.created',
      'run.started',
      'run.completed',
      'run.failed',
      'run.step.started',
      'run.step.progress',
      'run.step.completed',
      'run.step.failed'
    ];
    for (const t of known) es.addEventListener(t, onAny);

    es.onopen = () => setStatus('connected');
    es.onerror = () => setStatus('error');

    return () => {
      es.close();
    };
  }, [url, max]);

  return (
    <div className="rounded-xl border border-matrix-500/20 bg-black/25 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-matrix-200/90">Event feed</div>
        <div
          className={
            status === 'connected'
              ? 'text-[11px] text-matrix-200/80'
              : status === 'connecting'
                ? 'text-[11px] text-zinc-400'
                : 'text-[11px] text-red-200'
          }
        >
          {status}
        </div>
      </div>

      <div className="max-h-80 space-y-2 overflow-auto pr-1">
        {events.length === 0 ? (
          <div className="text-[11px] text-zinc-400">No events yet.</div>
        ) : null}

        {events.map((e) => (
          <div key={`${e.id}:${e.seq}:${e.ts}`} className="rounded-lg border border-matrix-500/10 bg-black/20 p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-zinc-300">{fmtTs(e.ts)}</div>
              <div className="text-[11px] text-matrix-200/90">{e.type}</div>
            </div>
            <div className="mt-1 text-[11px] text-zinc-200">
              {summarisePayload(e.payload)}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 text-[10px] text-zinc-500">{url}</div>
    </div>
  );
}
