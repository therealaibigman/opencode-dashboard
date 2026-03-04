'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBasePath } from './useBasePath';
import { RunTimeline } from './RunTimeline';

type RunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  status: string;
  modelProfile: string;
  kind: 'execute' | 'plan';
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type ArtifactStub = {
  id: string;
  project_id: string;
  run_id: string;
  step_id: string | null;
  kind: string;
  name: string;
  created_at: string;
};

type ArtifactFull = ArtifactStub & { content_text: string };

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

function fmtTs(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { hour12: false });
}

function canCancel(status: string | null | undefined) {
  return status === 'queued' || status === 'running' || status === 'needs_approval';
}

function isActive(status: string | null | undefined) {
  return status === 'queued' || status === 'running' || status === 'needs_approval';
}

export function RunDetails({ runId }: { runId: string }) {
  const BASE = useBasePath();

  const api = useMemo(
    () => ({
      run: `${BASE}/api/runs/${encodeURIComponent(runId)}`,
      cancel: `${BASE}/api/runs/${encodeURIComponent(runId)}/cancel`,
      approve: `${BASE}/api/runs/${encodeURIComponent(runId)}/approve`,
      reject: `${BASE}/api/runs/${encodeURIComponent(runId)}/reject`,
      approvePlan: `${BASE}/api/runs/${encodeURIComponent(runId)}/approve-plan`,
      rejectPlan: `${BASE}/api/runs/${encodeURIComponent(runId)}/reject-plan`,
      artifacts: `${BASE}/api/runs/${encodeURIComponent(runId)}/artifacts`,
      artifact: (id: string) => `${BASE}/api/artifacts/${encodeURIComponent(id)}`,
      eventsStream: `${BASE}/api/runs/${encodeURIComponent(runId)}/events/stream`
    }),
    [BASE, runId]
  );

  const [run, setRun] = useState<RunRow | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactStub[]>([]);
  const [openArtifact, setOpenArtifact] = useState<ArtifactFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const stopRef = useRef(false);

  async function refreshRun() {
    const r = await j<{ run: RunRow }>(await fetch(api.run, { cache: 'no-store' }));
    setRun(r.run);
  }

  async function refreshArtifacts() {
    const a = await j<{ artifacts: ArtifactStub[] }>(await fetch(api.artifacts, { cache: 'no-store' }));
    setArtifacts(a.artifacts);
  }

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      await Promise.all([refreshRun(), refreshArtifacts()]);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function cancelRun() {
    if (!canCancel(run?.status)) return;

    const ok = window.confirm(`Cancel run ${runId}?`);
    if (!ok) return;

    setErr(null);
    setCancelling(true);
    try {
      await j(await fetch(api.cancel, { method: 'POST' }));
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setCancelling(false);
    }
  }

  async function approve() {
    if (run?.status !== 'needs_approval') return;

    if (run.kind === 'plan') {
      const ok = window.confirm(`Approve plan for run ${runId}?\n\nThis will queue an execute run.`);
      if (!ok) return;

      setErr(null);
      setApproving(true);
      try {
        const data = await j<{ ok: boolean; execute_run_id: string }>(await fetch(api.approvePlan, { method: 'POST' }));
        // jump straight to the execution run
        window.location.href = `/runs/${encodeURIComponent(data.execute_run_id)}`;
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      } finally {
        setApproving(false);
      }
      return;
    }

    const ok = window.confirm(
      `Approve and apply changes for run ${runId}?\n\nThis will apply the patch, run checks, and commit automatically.`
    );
    if (!ok) return;

    setErr(null);
    setApproving(true);
    try {
      await j(await fetch(api.approve, { method: 'POST' }));
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setApproving(false);
    }
  }

  async function reject() {
    if (run?.status !== 'needs_approval') return;

    const ok = window.confirm(`Reject changes for run ${runId}?`);
    if (!ok) return;

    setErr(null);
    setRejecting(true);
    try {
      if (run.kind === 'plan') {
        await j(
          await fetch(api.rejectPlan, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'Rejected in UI' })
          })
        );
      } else {
        await j(
          await fetch(api.reject, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'Rejected in UI' })
          })
        );
      }
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setRejecting(false);
    }
  }

  async function loadArtifact(id: string) {
    const data = await j<{ artifact: ArtifactFull }>(await fetch(api.artifact(id), { cache: 'no-store' }));
    setOpenArtifact(data.artifact);
  }

  useEffect(() => {
    refresh().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.run, api.artifacts]);

  useEffect(() => {
    stopRef.current = false;
    if (!isActive(run?.status)) return;

    const t = setInterval(() => {
      if (stopRef.current) return;
      refreshArtifacts().catch(() => void 0);
      refreshRun().catch(() => void 0);
    }, 1500);

    return () => {
      stopRef.current = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status, api.artifacts, api.run]);

  useEffect(() => {
    stopRef.current = false;
    const es = new EventSource(api.eventsStream);

    const onArtifact = () => {
      refreshArtifacts().catch(() => void 0);
    };

    es.addEventListener('artifact.created', onArtifact);

    return () => {
      stopRef.current = true;
      try {
        es.removeEventListener('artifact.created', onArtifact);
        es.close();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.eventsStream]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-xs text-zinc-400">Run</div>
          <div className="min-w-0 break-all text-lg font-semibold text-zinc-100">{runId}</div>
          <Link className="text-xs text-matrix-200/90 hover:underline" href={{ pathname: '/', query: { tab: 'runs' } }}>
            ← Back to runs
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh()}
            className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
          >
            Refresh
          </button>

          <button
            onClick={() => cancelRun()}
            disabled={cancelling || !canCancel(run?.status) || approving || rejecting}
            className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-100 ring-1 ring-red-500/30 hover:bg-red-500/15 disabled:opacity-60"
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
      </div>

      {run?.status === 'needs_approval' ? (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-950/20 p-3">
          <div className="mb-2 text-sm font-medium text-yellow-100">Approval required</div>
          <div className="mb-3 text-xs text-yellow-100/80">
            {run.kind === 'plan'
              ? 'This run produced a plan. Approve to queue an execute run.'
              : 'This run generated a patch but policy blocked auto-apply. You can approve to apply the patch, run checks, and commit.'}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => approve()}
              disabled={approving || rejecting}
              className="rounded-lg bg-yellow-500/15 px-3 py-2 text-sm text-yellow-100 ring-1 ring-yellow-500/30 hover:bg-yellow-500/20 disabled:opacity-60"
            >
              {approving ? 'Approving…' : run.kind === 'plan' ? 'Approve plan → Execute' : 'Approve + Apply + Commit'}
            </button>
            <button
              onClick={() => reject()}
              disabled={approving || rejecting}
              className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
            >
              {rejecting ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        </div>
      ) : null}

      {err ? (
        <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-3 text-sm text-red-100">{err}</div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-matrix-500/20 bg-black/20 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Run metadata</div>

          {loading && !run ? <div className="text-[11px] text-zinc-400">Loading…</div> : null}

          {run ? (
            <div className="space-y-2 text-xs text-zinc-200">
              <div>
                <span className="text-zinc-400">kind:</span> {run.kind}
              </div>
              <div>
                <span className="text-zinc-400">status:</span> {run.status}
              </div>
              <div className="min-w-0 break-all">
                <span className="text-zinc-400">project:</span> {run.projectId}
              </div>
              <div className="min-w-0 break-all">
                <span className="text-zinc-400">task:</span> {run.taskId ?? '—'}
              </div>
              <div>
                <span className="text-zinc-400">model_profile:</span> {run.modelProfile}
              </div>
              <div>
                <span className="text-zinc-400">created:</span> {fmtTs(run.createdAt)}
              </div>
              <div>
                <span className="text-zinc-400">started:</span> {fmtTs(run.startedAt)}
              </div>
              <div>
                <span className="text-zinc-400">finished:</span> {fmtTs(run.finishedAt)}
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-matrix-500/20 bg-black/20 p-3 md:col-span-2">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Artifacts</div>
          {artifacts.length === 0 ? (
            <div className="text-[11px] text-zinc-400">No artifacts yet.</div>
          ) : (
            <div className="space-y-2">
              {artifacts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => loadArtifact(a.id)}
                  className="block w-full min-w-0 rounded-lg border border-matrix-500/10 bg-black/20 p-2 text-left hover:bg-black/30"
                >
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0 break-words text-xs text-zinc-100">{a.name}</div>
                    <div className="text-[11px] text-zinc-400">{a.kind}</div>
                  </div>
                  <div className="mt-1 min-w-0 break-all text-[10px] text-zinc-500">
                    {a.id}
                    {a.step_id ? ` • ${a.step_id}` : ''}
                  </div>
                </button>
              ))}
            </div>
          )}

          {openArtifact ? (
            <div className="mt-3 rounded-xl border border-matrix-500/15 bg-black/25 p-3">
              <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 break-words text-xs font-medium text-zinc-100">{openArtifact.name}</div>
                <div className="text-[11px] text-zinc-400">{openArtifact.kind}</div>
              </div>
              <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-200">
                {openArtifact.content_text}
              </pre>
              <div className="mt-2 min-w-0 break-all text-[10px] text-zinc-500">artifact: {openArtifact.id}</div>
            </div>
          ) : null}
        </div>
      </div>

      <RunTimeline runId={runId} />
    </div>
  );
}
