'use client';

import { useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';

type Ev = {
  id: string;
  ts: string;
  seq: number;
  type: string;
  source: string;
  severity: string;
  run_id?: string;
  step_id?: string;
  payload: any;
};

function fmtTs(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function RunTimeline({ runId }: { runId: string }) {
  const BASE = useBasePath();
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');

  const url = useMemo(
    () => `${BASE}/api/runs/${encodeURIComponent(runId)}/events/stream`,
    [BASE, runId]
  );

  useEffect(() => {
    setEvents([]);
    setStatus('connecting');

    const es = new EventSource(url);

    const onAny = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as Ev;
        setEvents((prev) => [...prev, e].slice(-600));
      } catch {
        // ignore
      }
    };

    es.onmessage = onAny;
    es.onerror = () => setStatus('error');
    es.onopen = () => setStatus('connected');

    return () => es.close();
  }, [url]);

  return (
    <div className="flex h-full min-h-[420px] flex-col rounded-xl border border-matrix-500/20 bg-black/25 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-matrix-200/90">Run timeline</div>
        <div className={status === 'connected' ? 'text-[11px] text-matrix-200/80' : status === 'error' ? 'text-[11px] text-red-200' : 'text-[11px] text-zinc-400'}>
          {status}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {events.length === 0 ? <div className="text-[11px] text-zinc-400">No events yet.</div> : null}
        <div className="space-y-2 pr-1">
          {events.map((e) => (
            <div key={`${e.id}:${e.seq}`} className="rounded-lg border border-matrix-500/10 bg-black/20 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-zinc-300">{fmtTs(e.ts)} #{e.seq}</div>
                <div className="text-[11px] text-matrix-200/90">{e.type}</div>
              </div>
              {e.step_id ? <div className="mt-1 text-[10px] text-zinc-500">{e.step_id}</div> : null}
              {e.payload?.message ? (
                <div className="mt-1 text-[11px] text-zinc-200">{String(e.payload.message)}</div>
              ) : null}
              {typeof e.payload?.percent === 'number' ? (
                <div className="mt-1 text-[11px] text-zinc-300">{e.payload.percent}%</div>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 truncate text-[10px] text-zinc-500">{url}</div>
    </div>
  );
}
