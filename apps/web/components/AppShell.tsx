'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from './ProjectContext';
import { useBasePath } from './useBasePath';
import { useRouter } from 'next/navigation';

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

type ApprovalRequested = {
  id: string;
  ts: string;
  type: 'approval.requested';
  project_id?: string;
  run_id?: string;
  task_id?: string;
  payload?: { reason?: string; patch_artifact_id?: string };
};

export function AppShell({ title, children }: { title?: string; children: React.ReactNode }) {
  const BASE = useBasePath();
  const router = useRouter();
  const { projects, selectedProjectId, setSelectedProjectId, refreshProjects } = useProject();

  const [creatingDemo, setCreatingDemo] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [err, setErr] = useState<string | null>(null);

  // approval modal state
  const [approval, setApproval] = useState<ApprovalRequested | null>(null);
  const [approvalErr, setApprovalErr] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<'approve' | 'reject' | null>(null);
  const lastApprovalIdRef = useRef<string | null>(null);

  const api = useMemo(
    () => ({
      projects: `${BASE}/api/projects`,
      project: (id: string) => `${BASE}/api/projects/${encodeURIComponent(id)}`,
      projectEvents: (id: string) => `${BASE}/api/projects/${encodeURIComponent(id)}/events/stream`,
      approveRun: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/approve`,
      rejectRun: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/reject`
    }),
    [BASE]
  );

  async function ensureDemoProject() {
    setErr(null);
    setCreatingDemo(true);
    try {
      const res = await fetch(api.projects, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'prj_demo', name: 'Demo' })
      });
      await j(res);
      await refreshProjects();
      setSelectedProjectId('prj_demo');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setCreatingDemo(false);
    }
  }

  async function createProject() {
    const name = newProjectName.trim();
    const id = newProjectId.trim();
    if (!name) {
      setErr('Project name is required');
      return;
    }

    setErr(null);
    setCreatingProject(true);
    try {
      const res = await fetch(api.projects, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ...(id ? { id } : {}) })
      });

      const data = await j<{ project: { id: string; name: string } }>(res);
      await refreshProjects();
      setSelectedProjectId(data.project.id);
      setNewProjectName('');
      setNewProjectId('');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setCreatingProject(false);
    }
  }

  async function deleteSelectedProject() {
    if (!selectedProjectId) return;

    const p = projects.find((x) => x.id === selectedProjectId);
    const label = p ? `${p.name} (${p.id})` : selectedProjectId;

    const ok = window.confirm(
      `Delete project ${label}?\n\nThis will permanently delete tasks, runs, artifacts, and events for this project.`
    );
    if (!ok) return;

    setErr(null);
    setDeleting(true);
    try {
      const res = await fetch(api.project(selectedProjectId), { method: 'DELETE' });
      await j(res);

      await refreshProjects();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setDeleting(false);
    }
  }

  // Live approval modal: listen on project stream for approval.requested
  useEffect(() => {
    if (!selectedProjectId) return;

    const es = new EventSource(api.projectEvents(selectedProjectId));

    const onApproval = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as ApprovalRequested;
        if (!data?.id || data.type !== 'approval.requested') return;

        // de-dupe
        if (lastApprovalIdRef.current === data.id) return;
        lastApprovalIdRef.current = data.id;

        setApprovalErr(null);
        setApprovalBusy(null);
        setApproval(data);
      } catch {
        // ignore
      }
    };

    es.addEventListener('approval.requested', onApproval);

    return () => {
      try {
        es.removeEventListener('approval.requested', onApproval);
        es.close();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, api.projectEvents]);

  async function approveFromModal() {
    const runId = approval?.run_id;
    if (!runId) return;
    setApprovalErr(null);
    setApprovalBusy('approve');
    try {
      await j(await fetch(api.approveRun(runId), { method: 'POST' }));
      setApproval(null);
    } catch (e: any) {
      setApprovalErr(String(e?.message ?? e));
    } finally {
      setApprovalBusy(null);
    }
  }

  async function rejectFromModal() {
    const runId = approval?.run_id;
    if (!runId) return;
    setApprovalErr(null);
    setApprovalBusy('reject');
    try {
      await j(
        await fetch(api.rejectRun(runId), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'Rejected in modal' })
        })
      );
      setApproval(null);
    } catch (e: any) {
      setApprovalErr(String(e?.message ?? e));
    } finally {
      setApprovalBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen w-full">
      <aside className="hidden w-80 shrink-0 border-r border-matrix-500/15 bg-black/25 p-4 md:block">
        <div className="mb-4 min-w-0">
          <div className="text-xs text-matrix-200/80">OpenCode Dashboard</div>
          <div className="min-w-0 break-words text-lg font-semibold text-matrix-100">{title ?? 'Control Room'}</div>
        </div>

        <div className="mb-2 text-xs text-zinc-300">Project</div>
        <select
          className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
          {!projects.find((p) => p.id === selectedProjectId) && <option value={selectedProjectId}>{selectedProjectId}</option>}
        </select>

        <div className="mt-4 rounded-xl border border-matrix-500/15 bg-black/15 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Create project</div>

          <div className="space-y-2">
            <input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Project name (required)"
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />

            <input
              value={newProjectId}
              onChange={(e) => setNewProjectId(e.target.value)}
              placeholder="Project id (optional, e.g. prj_acme)"
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />

            <button
              onClick={createProject}
              disabled={creatingProject}
              className="w-full rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40 hover:bg-matrix-500/20 disabled:opacity-60"
            >
              {creatingProject ? 'Creating…' : 'Create Project'}
            </button>

            <div className="text-[11px] text-zinc-500">If you leave id blank, the API generates one.</div>
          </div>
        </div>

        <div className="mt-3 grid gap-2">
          <button
            onClick={ensureDemoProject}
            disabled={creatingDemo}
            className="w-full rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
          >
            {creatingDemo ? 'Working…' : 'Ensure Demo'}
          </button>

          <button
            onClick={deleteSelectedProject}
            disabled={deleting || creatingDemo || creatingProject || !selectedProjectId}
            className="w-full rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-100 ring-1 ring-red-500/30 hover:bg-red-500/15 disabled:opacity-60"
          >
            {deleting ? 'Deleting…' : 'Delete Project'}
          </button>

          <div className="text-[11px] text-zinc-500">Deleting a project cascades to tasks/runs/artifacts. Events are purged too.</div>
        </div>

        {err ? (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-950/30 p-2 text-xs text-red-100">{err}</div>
        ) : null}

        <div className="mt-6 text-[11px] text-zinc-500">
          basePath: <span className="text-zinc-300">{BASE || '(none)'}</span>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>

      {approval ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur" onClick={() => setApproval(null)} />

          <div className="relative mx-4 w-full max-w-xl rounded-2xl border border-yellow-500/30 bg-black/80 p-4 shadow-neon">
            <div className="mb-1 text-sm font-semibold text-yellow-100">Approval required</div>
            <div className="text-xs text-yellow-100/80">
              Run: <span className="break-all text-yellow-50">{approval.run_id ?? '(unknown)'}</span>
            </div>
            {approval.payload?.reason ? (
              <div className="mt-2 text-xs text-zinc-200">
                <span className="text-zinc-400">reason:</span> {String(approval.payload.reason)}
              </div>
            ) : null}
            {approval.payload?.patch_artifact_id ? (
              <div className="mt-1 text-[11px] text-zinc-400 break-all">patch artifact: {approval.payload.patch_artifact_id}</div>
            ) : null}

            {approvalErr ? (
              <div className="mt-3 rounded-lg border border-red-500/30 bg-red-950/30 p-2 text-xs text-red-100">{approvalErr}</div>
            ) : null}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                onClick={() => setApproval(null)}
                className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
              >
                Close
              </button>

              {approval.run_id ? (
                <button
                  onClick={() => {
                    setApproval(null);
                    router.push(`/runs/${encodeURIComponent(approval.run_id!)}`);
                  }}
                  className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
                >
                  Open run
                </button>
              ) : null}

              <button
                onClick={() => rejectFromModal()}
                disabled={approvalBusy !== null}
                className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
              >
                {approvalBusy === 'reject' ? 'Rejecting…' : 'Reject'}
              </button>

              <button
                onClick={() => approveFromModal()}
                disabled={approvalBusy !== null || !approval.run_id}
                className="rounded-lg bg-yellow-500/15 px-3 py-2 text-sm text-yellow-100 ring-1 ring-yellow-500/30 hover:bg-yellow-500/20 disabled:opacity-60"
              >
                {approvalBusy === 'approve' ? 'Approving…' : 'Approve + Apply + Commit'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
