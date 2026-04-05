'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { validatePlanJson } from '@ocdash/shared';
import { useBasePath } from './useBasePath';
import { useSettings } from './useSettings';
import { RunTimeline } from './RunTimeline';

type RunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  status: string;
  modelProfile: string;
  kind: 'execute' | 'plan' | 'review';
  parentRunId: string | null;
  threadId: string | null;
  prUrl: string | null;
  prBranch: string | null;
  prState: string | null;
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

type StepRow = { id: string; name: string; status: string; model: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string };

type ThreadRow = { id: string; title: string; taskId: string | null; createdAt: string; updatedAt: string };
type MessageRow = { id: string; role: string; contentMd: string; createdAt: string };

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

function RiskTag({ risk }: { risk: string }) {
  const cls =
    risk === 'high'
      ? 'bg-red-500/15 text-red-100 ring-red-500/30'
      : risk === 'med'
        ? 'bg-yellow-500/15 text-yellow-100 ring-yellow-500/30'
        : 'bg-matrix-500/15 text-matrix-100 ring-matrix-500/30';

  return <span className={`rounded-full px-2 py-1 text-[11px] ring-1 ${cls}`}>{risk}</span>;
}

function PlanViewer({ planText }: { planText: string }) {
  const v = validatePlanJson(planText);

  if (!v.ok) {
    return (
      <div>
        <div className="mb-2 text-xs text-zinc-400">Plan JSON (raw)</div>
        <div className="mb-2 rounded-lg border border-red-500/30 bg-red-950/30 p-2 text-xs text-red-100">
          Invalid plan format: {v.error}
        </div>
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-200">
          {planText}
        </pre>
      </div>
    );
  }

  const plan = v.plan;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs font-medium text-matrix-200/90">Summary</div>
        <div className="text-sm text-zinc-100">{plan.summary || '—'}</div>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Steps</div>
        {!plan.steps?.length ? (
          <div className="text-[11px] text-zinc-400">No steps provided.</div>
        ) : (
          <ol className="space-y-2">
            {plan.steps.map((s, idx) => (
              <li key={idx} className="rounded-xl border border-matrix-500/15 bg-black/25 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-zinc-100">
                    {idx + 1}. {s.title || 'Step'}
                  </div>
                  {s.risk ? <RiskTag risk={s.risk} /> : null}
                </div>
                {s.details ? (
                  <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-zinc-200">{s.details}</div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-matrix-500/15 bg-black/20 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Files</div>
          {!plan.files?.length ? (
            <div className="text-[11px] text-zinc-400">None listed.</div>
          ) : (
            <ul className="space-y-1 text-[11px] text-zinc-200">
              {plan.files.map((f) => (
                <li key={f} className="break-all">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-matrix-500/15 bg-black/20 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Commands</div>
          {!plan.commands?.length ? (
            <div className="text-[11px] text-zinc-400">None listed.</div>
          ) : (
            <ul className="space-y-1 text-[11px] text-zinc-200">
              {plan.commands.map((c) => (
                <li key={c} className="break-all font-mono">
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <details className="rounded-xl border border-matrix-500/10 bg-black/20 p-3">
        <summary className="cursor-pointer select-none text-xs text-zinc-200">Raw plan JSON</summary>
        <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-200">
          {JSON.stringify(plan, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function RunDetails({ runId }: { runId: string }) {
  const BASE = useBasePath();
  const { settings } = useSettings();

  const api = useMemo(
    () => ({
      run: `${BASE}/api/runs/${encodeURIComponent(runId)}`,
      cancel: `${BASE}/api/runs/${encodeURIComponent(runId)}/cancel`,
      approve: `${BASE}/api/runs/${encodeURIComponent(runId)}/approve`,
      reject: `${BASE}/api/runs/${encodeURIComponent(runId)}/reject`,
      approvePlan: `${BASE}/api/runs/${encodeURIComponent(runId)}/approve-plan`,
      rejectPlan: `${BASE}/api/runs/${encodeURIComponent(runId)}/reject-plan`,
      runs: `${BASE}/api/runs`,
      artifacts: `${BASE}/api/runs/${encodeURIComponent(runId)}/artifacts`,
      artifact: (id: string) => `${BASE}/api/artifacts/${encodeURIComponent(id)}`,
      events: `${BASE}/api/runs/${encodeURIComponent(runId)}/events`,
      thread: (id: string) => `${BASE}/api/threads/${encodeURIComponent(id)}`,
      messages: (id: string) => `${BASE}/api/threads/${encodeURIComponent(id)}/messages`,
      eventsStream: `${BASE}/api/runs/${encodeURIComponent(runId)}/events/stream`,
      steps: `${BASE}/api/runs/${encodeURIComponent(runId)}/steps`
    }),
    [BASE, runId]
  );

  const [run, setRun] = useState<RunRow | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactStub[]>([]);
  const [openArtifact, setOpenArtifact] = useState<ArtifactFull | null>(null);
  const [steps, setSteps] = useState<StepRow[]>([]);
  const [thread, setThread] = useState<ThreadRow | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [newMsg, setNewMsg] = useState('');
  const [sending, setSending] = useState(false);

  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [queueingExecute, setQueueingExecute] = useState(false);

  const stopRef = useRef(false);

  async function refreshRun() {
    const r = await j<{ run: RunRow }>(await fetch(api.run, { cache: 'no-store' }));
    setRun(r.run);
    await refreshThreadAndMessages(r.run);
  }

  async function refreshThreadAndMessages(runRow?: RunRow | null) {
    const r = runRow ?? run;
    const tid = r?.threadId;
    if (!tid) return;
    const thr = await j<{ threads: any[] }>(await fetch(`${BASE}/api/threads?project_id=${encodeURIComponent(r.projectId)}&task_id=${encodeURIComponent(r.taskId ?? '')}`, { cache: 'no-store' }));
    const found = (thr.threads ?? []).find((t: any) => t.id === tid);
    if (found) setThread(found as any);
    const msgs = await j<{ messages: MessageRow[] }>(await fetch(api.messages(tid), { cache: 'no-store' }));
    setMessages(msgs.messages);
  }

  async function refreshSteps() {
    try {
      const data = await j<{ steps: StepRow[] }>(await fetch(api.steps, { cache: 'no-store' }));
      setSteps(data.steps);
    } catch {
      // ignore
    }
  }

  async function refreshArtifacts() {

    const a = await j<{ artifacts: ArtifactStub[] }>(await fetch(api.artifacts, { cache: 'no-store' }));
    setArtifacts(a.artifacts);
  }

  async function refresh() {
    setErr(null);
    setLoading(true);
    try {
      await Promise.all([refreshRun(), refreshArtifacts(), refreshSteps()]);
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
        const data = await j<{ ok: boolean; execute_run_id: string }>(
          await fetch(api.approvePlan, { method: 'POST' })
        );
        window.location.href = `${BASE}/runs/${encodeURIComponent(data.execute_run_id)}`;
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      } finally {
        setApproving(false);
      }
      return;
    }

    const ok = window.confirm(
      `Approve and apply changes for run ${runId}?\n\nThis will apply the patch, run checks, commit, and publish (PR for existing repos; direct push for new repos).`
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

  async function queueExecuteFromThisPlan() {
    if (!run || run.kind !== 'plan') return;

    const ok = window.confirm(`Queue a new execute run from this plan?\n\nPlan run: ${run.id}`);
    if (!ok) return;

    setErr(null);
    setQueueingExecute(true);
    try {
      const res = await fetch(api.runs, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: run.projectId,
          task_id: run.taskId,
          model_profile: run.modelProfile,
          kind: 'execute',
          parent_run_id: run.id,
          pipeline_id: settings.defaultPipelineId || null
        })
      });
      const data = await j<{ run: { id: string } }>(res);
      window.location.href = `${BASE}/runs/${encodeURIComponent(data.run.id)}`;
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setQueueingExecute(false);
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

  async function sendThreadMessage() {
    if (!run?.threadId) return;
    const content = newMsg.trim();
    if (!content) return;
    setSending(true);
    try {
      await j(
        await fetch(api.messages(run.threadId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'user', content_md: content })
        })
      );
      setNewMsg('');
      await refreshThreadAndMessages();
    } finally {
      setSending(false);
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

  // Poll for github.pr.create failures for a small banner (SSE can be flaky behind proxies).
  useEffect(() => {
    if (!isActive(run?.status)) return;

    let stop = false;
    const tick = async () => {
      try {
        const data = await j<{ events: any[] }>(await fetch(`${api.events}?limit=200`, { cache: 'no-store' }));
        const failed = (data.events ?? [])
          .filter((e) => e.type === 'tool.call.failed' && (e.payload?.tool === 'github.pr.create' || e.payload?.tool === 'github.push.initial'))
          .slice(-1)[0];
        if (!stop) setPrError(failed?.payload?.error ? String(failed.payload.error) : null);
      } catch {
        // ignore
      }
    };

    tick().catch(() => void 0);
    const t = setInterval(() => {
      if (stop) return;
      tick().catch(() => void 0);
    }, 2500);

    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [api.events, run?.status]);

  useEffect(() => {
    stopRef.current = false;
    if (!isActive(run?.status)) return;

    const t = setInterval(() => {
      if (stopRef.current) return;
      refreshArtifacts().catch(() => void 0);
      refreshRun().catch(() => void 0);
      refreshSteps().catch(() => void 0);
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

  const publishNote = run?.prState === 'pushed' ? `Published via direct push to ${run.prBranch ?? '(base branch)'}` : null;

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

      {prError ? (
        <div className="rounded-xl border border-yellow-500/25 bg-yellow-950/20 p-3 text-sm text-yellow-50">
          Publish failed: <span className="text-yellow-100/80">{prError}</span>
        </div>
      ) : null}

      {run?.prUrl ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-matrix-500/20 bg-black/20 p-3">
          <div className="text-sm text-zinc-200">PR:</div>
          <a className="break-all text-sm text-matrix-200/90 hover:underline" href={run.prUrl} target="_blank" rel="noreferrer">
            {run.prUrl}
          </a>
          {run.prBranch ? <span className="text-[11px] text-zinc-500">({run.prBranch})</span> : null}
        </div>
      ) : publishNote ? (
        <div className="rounded-xl border border-matrix-500/20 bg-black/20 p-3 text-sm text-zinc-200">{publishNote}</div>
      ) : null}

      {run?.kind === 'plan' ? (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => queueExecuteFromThisPlan()}
            disabled={queueingExecute}
            className="rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20 disabled:opacity-60"
          >
            {queueingExecute ? 'Queueing…' : 'Re-run execute from this plan'}
          </button>
        </div>
      ) : null}

      {run?.status === 'needs_approval' ? (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-950/20 p-3">
          <div className="mb-2 text-sm font-medium text-yellow-100">Approval required</div>
          <div className="mb-3 text-xs text-yellow-100/80">
            {run.kind === 'plan'
              ? 'This run produced a plan. Approve to queue an execute run.'
              : 'This run generated a patch but policy blocked auto-apply. You can approve to apply the patch, run checks, commit, and publish (PR for existing repos; direct push for new repos).'}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => approve()}
              disabled={approving || rejecting}
              className="rounded-lg bg-yellow-500/15 px-3 py-2 text-sm text-yellow-100 ring-1 ring-yellow-500/30 hover:bg-yellow-500/20 disabled:opacity-60"
            >
              {approving ? 'Approving…' : run.kind === 'plan' ? 'Approve plan → Execute' : 'Approve + Apply + Commit + Publish'}
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
              <div className="min-w-0 break-all">
                <span className="text-zinc-400">parent_run:</span> {run.parentRunId ?? '—'}
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

              {openArtifact.kind === 'plan' ? (
                <PlanViewer planText={openArtifact.content_text} />
              ) : (
                <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-200">
                  {openArtifact.content_text}
                </pre>
              )}

              <div className="mt-2 min-w-0 break-all text-[10px] text-zinc-500">artifact: {openArtifact.id}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Thread & Messages</div>
        {!run?.threadId ? (
          <div className="text-[11px] text-zinc-400">No thread linked to this run.</div>
        ) : (
          <div className="space-y-3">
            <div className="text-[11px] text-zinc-400 break-all">thread: {run.threadId}</div>
            {messages.length === 0 ? <div className="text-[11px] text-zinc-400">No messages yet.</div> : null}
            <div className="max-h-64 space-y-2 overflow-auto pr-1">
              {messages.map((m) => (
                <div key={m.id} className="rounded-lg border border-matrix-500/10 bg-black/20 p-2">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] text-zinc-300">{m.role}</div>
                    <div className="text-[10px] text-zinc-500">{fmtTs(m.createdAt)}</div>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-100">{m.contentMd}</div>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <input
                value={newMsg}
                onChange={(e) => setNewMsg(e.target.value)}
                placeholder="Message…"
                className="w-full rounded-lg border border-matrix-500/20 bg-black/25 px-2 py-2 text-xs text-zinc-100 outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendThreadMessage();
                }}
              />
              <button
                onClick={() => void sendThreadMessage()}
                disabled={sending}
                className="shrink-0 rounded-lg bg-matrix-500/15 px-3 py-2 text-xs text-matrix-100 ring-1 ring-matrix-500/30 hover:bg-matrix-500/20 disabled:opacity-60"
              >
                {sending ? '…' : 'Send'}
              </button>
            </div>
            <div className="text-[10px] text-zinc-500">Ctrl/Cmd+Enter to send</div>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Run steps</div>
        {steps.length === 0 ? (
          <div className="text-[11px] text-zinc-400">No steps recorded.</div>
        ) : (
          <div className="space-y-2">
            {steps.map((st) => (
              <div key={st.id} className="rounded-xl border border-matrix-500/10 bg-black/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-medium text-zinc-100">{st.name}</div>
                  <div className="text-[11px] text-zinc-400">{st.status}</div>
                </div>
                <div className="mt-1 text-[10px] text-zinc-500 break-all">{st.id}</div>
                {st.model ? <div className="mt-1 text-[11px] text-zinc-400 break-all">model: {st.model}</div> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      <RunTimeline runId={runId} />
    </div>
  );
}
