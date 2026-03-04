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

function isToolCall(type: string) {
  return type === 'tool.call.requested' || type === 'tool.call.completed' || type === 'tool.call.failed';
}

type Artifact = {
  id: string;
  kind: string;
  name: string;
  content_text: string;
};

function ToolCallBlock({ e }: { e: Ev }) {
  const BASE = useBasePath();

  const tool = e.payload?.tool ? String(e.payload.tool) : '(tool)';
  const exitCode = e.payload?.result?.exit_code;

  const stdoutId = e.payload?.result?.stdout_artifact_id as string | undefined;
  const stderrId = e.payload?.result?.stderr_artifact_id as string | undefined;

  const stdoutPreview = e.payload?.result?.stdout_preview as string | undefined;
  const stderrPreview = e.payload?.result?.stderr_preview as string | undefined;

  const [stdout, setStdout] = useState<Artifact | null>(null);
  const [stderr, setStderr] = useState<Artifact | null>(null);

  async function loadArtifact(id: string, setter: (a: Artifact) => void) {
    const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { artifact: Artifact };
    setter(data.artifact);
  }

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 break-words text-[11px] text-zinc-200">
          <span className="text-zinc-400">tool:</span> {tool}
        </div>
        {typeof exitCode === 'number' ? (
          <div className={exitCode === 0 ? 'text-[11px] text-matrix-200/80' : 'text-[11px] text-red-200'}>
            exit {exitCode}
          </div>
        ) : null}
      </div>

      {stdoutId || stdoutPreview ? (
        <details
          className="rounded-lg border border-matrix-500/10 bg-black/25 p-2"
          onToggle={(ev) => {
            const open = (ev.target as HTMLDetailsElement).open;
            if (open && stdoutId && !stdout) void loadArtifact(stdoutId, (a) => setStdout(a));
          }}
        >
          <summary className="cursor-pointer select-none text-[11px] text-zinc-200">stdout</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-200">
            {stdout?.content_text ?? stdoutPreview ?? ''}
          </pre>
          {stdoutId ? <div className="mt-1 break-all text-[10px] text-zinc-500">artifact: {stdoutId}</div> : null}
        </details>
      ) : null}

      {stderrId || stderrPreview ? (
        <details
          className="rounded-lg border border-red-500/20 bg-red-950/20 p-2"
          onToggle={(ev) => {
            const open = (ev.target as HTMLDetailsElement).open;
            if (open && stderrId && !stderr) void loadArtifact(stderrId, (a) => setStderr(a));
          }}
        >
          <summary className="cursor-pointer select-none text-[11px] text-red-100">stderr</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] text-red-100">
            {stderr?.content_text ?? stderrPreview ?? ''}
          </pre>
          {stderrId ? (
            <div className="mt-1 break-all text-[10px] text-red-200/70">artifact: {stderrId}</div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export function RunTimeline({ runId }: { runId: string }) {
  const BASE = useBasePath();
  const [events, setEvents] = useState<Ev[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');

  const url = useMemo(() => `${BASE}/api/runs/${encodeURIComponent(runId)}/events/stream`, [BASE, runId]);

  useEffect(() => {
    setEvents([]);
    setStatus('connecting');

    const es = new EventSource(url);

    const onAny = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as Ev;
        setEvents((prev) => [...prev, e].slice(-800));
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
        <div
          className={
            status === 'connected'
              ? 'text-[11px] text-matrix-200/80'
              : status === 'error'
                ? 'text-[11px] text-red-200'
                : 'text-[11px] text-zinc-400'
          }
        >
          {status}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {events.length === 0 ? <div className="text-[11px] text-zinc-400">No events yet.</div> : null}
        <div className="space-y-2 pr-1">
          {events.map((e) => (
            <div key={`${e.id}:${e.seq}`} className="min-w-0 rounded-lg border border-matrix-500/10 bg-black/20 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-zinc-300">
                  {fmtTs(e.ts)} <span className="text-zinc-600">#{e.seq}</span>
                </div>
                <div className="min-w-0 break-words text-[11px] text-matrix-200/90">{e.type}</div>
              </div>

              {e.step_id ? <div className="mt-1 break-all text-[10px] text-zinc-500">{e.step_id}</div> : null}

              {e.payload?.message ? (
                <div className="mt-1 min-w-0 break-words text-[11px] text-zinc-200">{String(e.payload.message)}</div>
              ) : null}

              {typeof e.payload?.percent === 'number' ? (
                <div className="mt-1 text-[11px] text-zinc-300">{e.payload.percent}%</div>
              ) : null}

              {isToolCall(e.type) ? <ToolCallBlock e={e} /> : null}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 truncate text-[10px] text-zinc-500">{url}</div>
    </div>
  );
}
