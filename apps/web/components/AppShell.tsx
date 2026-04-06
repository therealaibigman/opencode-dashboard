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
  payload?: {
    reason?: string;
    patch_artifact_id?: string;
    plan_artifact_id?: string;
    stdout_artifact_id?: string;
    policy_level?: string;
    policy_decision_artifact_id?: string;
  };
};


type RunMeta = { run: { id: string; kind: 'execute' | 'plan' | 'review' | 'publish'; status: string } };

type Artifact = { id: string; kind: string; name: string; content_text: string };

function parseUnifiedDiffTouchedFiles(diff: string): string[] {
  const files = new Set<string>();
  const lines = String(diff ?? '').split('\n');
  for (const ln of lines) {
    // diff --git a/path b/path
    if (ln.startsWith('diff --git ')) {
      const m = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m?.[2]) files.add(m[2]);
    }
    // +++ b/path
    if (ln.startsWith('+++ ')) {
      const m = ln.match(/^\+\+\+\s+b\/(.+)$/);
      if (m?.[1] && m[1] !== '/dev/null') files.add(m[1]);
    }
  }
  return Array.from(files);
}

function detectRiskFlags(files: string[], diffText: string): string[] {
  const flags: string[] = [];
  const f = files.join('\n').toLowerCase();
  if (/(^|\n)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)(\n|$)/i.test(f)) flags.push('lockfile change');
  if (/(^|\n)package\.json(\n|$)/i.test(f)) flags.push('dependency change');
  if (/\bdrizzle\b\/|migrations\b|\.sql$/i.test(f)) flags.push('db/migration change');
  if (/(^|\n)(\.env|\.env\.|dockerfile|docker-compose\.yml|nginx|systemd|infra\/)(\n|$)/i.test(f)) flags.push('infra/config change');
  if (/BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|AKIA[0-9A-Z]{16}|xox[baprs]-/i.test(diffText)) flags.push('possible secret in diff');
  return flags;
}
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

  // project source config
  const selected = projects.find((p: any) => p.id === selectedProjectId) as any;
  const [localPath, setLocalPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [planModel, setPlanModel] = useState('');
  const [executeModel, setExecuteModel] = useState('');
  const [policyLevel, setPolicyLevel] = useState<'strict' | 'normal' | 'yolo'>('normal');
  const [savingSource, setSavingSource] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  // approval modal state
  const [approval, setApproval] = useState<ApprovalRequested | null>(null);
  const [approvalKind, setApprovalKind] = useState<'execute' | 'plan' | 'review' | 'publish' | null>(null);
  const [approvalErr, setApprovalErr] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<'approve' | 'reject' | null>(null);
  const [approvalDetails, setApprovalDetails] = useState<{
    files: string[];
    riskFlags: string[];
    previewText: string | null;
  } | null>(null);

  // de-dupe across reconnects
  const lastApprovalIdRef = useRef<string | null>(null);
  const shownRunIdsRef = useRef<Set<string>>(new Set());

  const api = useMemo(
    () => ({
      projects: `${BASE}/api/projects`,
      project: (id: string) => `${BASE}/api/projects/${encodeURIComponent(id)}`,
      projectSync: (id: string) => `${BASE}/api/projects/${encodeURIComponent(id)}/sync`,
      projectEvents: (id: string, afterTs?: string) => {
        const base = `${BASE}/api/projects/${encodeURIComponent(id)}/events/stream`;
        return afterTs ? `${base}?after_ts=${encodeURIComponent(afterTs)}` : base;
      },
      run: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}` ,
      approveRun: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/approve`,
      rejectRun: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/reject`,
      approvePlan: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/approve-plan`,
      rejectPlan: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/reject-plan`
    }),
    [BASE]
  );

  async function loadApprovalDetails(a: ApprovalRequested) {
    const patchId = a?.payload?.patch_artifact_id ?? '';
    const planId = a?.payload?.plan_artifact_id ?? '';
    const stdoutId = a?.payload?.stdout_artifact_id ?? '';
    const polId = a?.payload?.policy_decision_artifact_id ?? '';

    const artId = patchId || planId || stdoutId;
    if (!artId) {
      setApprovalDetails(null);
      return;
    }

    try {
      const res = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(artId)}`, { cache: 'no-store' });
      const data = await j<{ artifact: Artifact }>(res);
      const txt = String(data.artifact?.content_text ?? '');
      const files = patchId ? parseUnifiedDiffTouchedFiles(txt) : [];
      const riskFlags = patchId ? detectRiskFlags(files, txt) : [];
      const previewText = txt.length > 1600 ? `${txt.slice(0, 1600)}\n…(truncated)…` : txt;

      let policyDecisionText: string | null = null;
      if (polId) {
        try {
          const pr = await fetch(`${BASE}/api/artifacts/${encodeURIComponent(polId)}`, { cache: 'no-store' });
          const pdata = await j<{ artifact: Artifact }>(pr);
          const ptxt = String(pdata.artifact?.content_text ?? '').trim();
          policyDecisionText = ptxt ? (ptxt.length > 1200 ? `${ptxt.slice(0, 1200)}\n…(truncated)…` : ptxt) : null;
        } catch {
          policyDecisionText = null;
        }
      }

      setApprovalDetails({ files, riskFlags, previewText: policyDecisionText ? `${previewText}\n\n---\nPolicy decision:\n${policyDecisionText}` : previewText });
    } catch {
      setApprovalDetails(null);
    }
  }

  // hydrate source fields when selection changes
  useEffect(() => {
    setLocalPath(String(selected?.localPath ?? ''));
    setRepoUrl(String(selected?.repoUrl ?? ''));
    setDefaultBranch(String(selected?.defaultBranch ?? 'main'));
    setPlanModel(String(selected?.planModel ?? ''));
    setExecuteModel(String(selected?.executeModel ?? ''));
    setPolicyLevel((['strict', 'normal', 'yolo'].includes(String(selected?.policyLevel)) ? String(selected?.policyLevel) : 'normal') as any);
    setSyncNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, projects.length]);

  async function saveProjectSource() {
    if (!selectedProjectId) return;

    setErr(null);
    setSavingSource(true);
    try {
      await j(
        await fetch(api.project(selectedProjectId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            local_path: localPath.trim() || null,
            repo_url: repoUrl.trim() || null,
            default_branch: defaultBranch.trim() || null,
            plan_model: planModel.trim() || null,
            execute_model: executeModel.trim() || null,
            policy_level: policyLevel
          })
        })
      );

      await refreshProjects();
      setSyncNote('Saved.');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSavingSource(false);
    }
  }

  async function syncNow() {
    if (!selectedProjectId) return;

    setErr(null);
    setSyncNote(null);
    setSyncing(true);
    try {
      const data = await j<{ ok: boolean; mode?: string; workspace?: string }>(
        await fetch(api.projectSync(selectedProjectId), { method: 'POST' })
      );

      setSyncNote(`Synced (${data.mode}) → ${data.workspace}`);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSyncing(false);
    }
  }

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
    const label = p ? `${(p as any).name} (${(p as any).id})` : selectedProjectId;

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

    const storageKey = `ocdash:lastApprovalTs:${selectedProjectId}`;
    let afterTs = '';
    try {
      afterTs = sessionStorage.getItem(storageKey) ?? '';
    } catch {
      // ignore
    }

    if (!afterTs) afterTs = new Date(Date.now() - 5000).toISOString();

    const es = new EventSource(api.projectEvents(selectedProjectId, afterTs));

    const onApproval = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as ApprovalRequested;
        if (!data?.id || data.type !== 'approval.requested') return;

        try {
          if (data.ts) sessionStorage.setItem(storageKey, data.ts);
        } catch {
          // ignore
        }

        if (lastApprovalIdRef.current === data.id) return;
        lastApprovalIdRef.current = data.id;

        const runId = data.run_id ?? '';
        if (!runId) return;

        if (shownRunIdsRef.current.has(runId)) return;
        shownRunIdsRef.current.add(runId);

        if (approval?.run_id && approval.run_id === runId) return;

        setApprovalErr(null);
        setApprovalBusy(null);
        setApproval(data);
        setApprovalKind(null);
        setApprovalDetails(null);

        void loadApprovalDetails(data);

        void (async () => {
          try {
            const meta = await j<RunMeta>(await fetch(api.run(runId), { cache: 'no-store' }));
            setApprovalKind(meta.run.kind);
          } catch {
            setApprovalKind(data.payload?.plan_artifact_id ? 'plan' : 'execute');
          }
        })();
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
      if (approvalKind === 'plan' || approval?.payload?.plan_artifact_id) {
        const data = await j<{ ok: boolean; execute_run_id: string }>(
          await fetch(api.approvePlan(runId), { method: 'POST' })
        );
        setApproval(null);
        router.push(`/runs/${encodeURIComponent(data.execute_run_id)}`);
      } else {
        await j(await fetch(api.approveRun(runId), { method: 'POST' }));
        setApproval(null);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('needs_approval')) setApproval(null);
      else setApprovalErr(msg);
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
      if (approvalKind === 'plan' || approval?.payload?.plan_artifact_id) {
        await j(
          await fetch(api.rejectPlan(runId), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'Rejected in modal' })
          })
        );
      } else {
        await j(
          await fetch(api.rejectRun(runId), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'Rejected in modal' })
          })
        );
      }
      setApproval(null);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('needs_approval')) setApproval(null);
      else setApprovalErr(msg);
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
          {projects.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
          {!projects.find((p: any) => p.id === selectedProjectId) && <option value={selectedProjectId}>{selectedProjectId}</option>}
        </select>

        <div className="mt-4 rounded-xl border border-matrix-500/15 bg-black/15 p-3">
          <div className="mb-2 text-xs font-medium text-matrix-200/90">Project source</div>
          <div className="space-y-2">
            <input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="local path (optional)"
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="repo url (optional)"
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />
            <input
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="default branch (main)"
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />
            <input
              value={planModel}
              onChange={(e) => setPlanModel(e.target.value)}
              placeholder="plan model (optional)"
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />
            <input
              value={executeModel}
              onChange={(e) => setExecuteModel(e.target.value)}
              placeholder="execute model (optional)"
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
            />

            <div>
              <div className="mb-1 text-[11px] text-zinc-400">Policy level</div>
              <select
                value={policyLevel}
                onChange={(e) => setPolicyLevel(e.target.value as any)}
                className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
              >
                <option value="strict">strict (always approve mutations)</option>
                <option value="normal">normal (gate risky ops)</option>
                <option value="yolo">yolo (auto-apply allowed)</option>
              </select>
              <div className="mt-1 text-[10px] text-zinc-500">
                This is enforced server-side. UI settings don’t override it.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={saveProjectSource}
                disabled={savingSource || syncing || !selectedProjectId}
                className="w-full rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40 hover:bg-matrix-500/20 disabled:opacity-60"
              >
                {savingSource ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={syncNow}
                disabled={syncing || savingSource || !selectedProjectId}
                className="w-full rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35 disabled:opacity-60"
              >
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            <div className="text-[11px] text-zinc-500">
              If local path is set, the worker mirrors it into the workspace (excludes node_modules, .git, dist, etc.).
            </div>
            {syncNote ? <div className="text-[11px] text-matrix-200/90 break-words">{syncNote}</div> : null}
          </div>
        </div>

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
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-1 ring-matrix-500/40"
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
          <div className="mt-2">
            <a className="text-[11px] text-matrix-200/90 hover:underline" href="/admin/runs">Admin → Runs (retries)</a>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>

      {approval ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur" onClick={() => setApproval(null)} />

          <div className="relative mx-4 w-full max-w-xl rounded-2xl border border-yellow-500/30 bg-black/80 p-4 shadow-neon">
            <div className="mb-1 text-sm font-semibold text-yellow-100">Approval required</div>
            <div className="text-xs text-yellow-100">
              Run: <span className="break-all text-yellow-50">{approval.run_id ?? '(unknown)'}</span>
            </div>
            {approval.payload?.reason ? (
              <div className="mt-2 text-xs text-zinc-200">
                <span className="text-zinc-400">reason:</span> {String(approval.payload.reason)}
              </div>
            ) : null}

            {approval.payload?.policy_level ? (
              <div className="mt-1 text-[11px] text-zinc-400">
                policy: <span className="text-zinc-200">{String(approval.payload.policy_level)}</span>
              </div>
            ) : null}
            {approval.payload?.patch_artifact_id ? (
              <div className="mt-1 break-all text-[11px] text-zinc-400">patch artifact: {approval.payload.patch_artifact_id}</div>
            ) : null}
            {approval.payload?.plan_artifact_id ? (
              <div className="mt-1 break-all text-[11px] text-zinc-400">plan artifact: {approval.payload.plan_artifact_id}</div>
            ) : null}

            {approval.payload?.stdout_artifact_id ? (
              <div className="mt-1 break-all text-[11px] text-zinc-400">stdout artifact: {approval.payload.stdout_artifact_id}</div>
            ) : null}

            {approvalDetails ? (
              <div className="mt-3 rounded-xl border border-matrix-500/15 bg-black/30 p-3">
                {approvalDetails.files?.length ? (
                  <div className="mb-2">
                    <div className="text-[11px] font-medium text-matrix-200/90">Files touched</div>
                    <div className="mt-1 space-y-1 text-[11px] text-zinc-200">
                      {approvalDetails.files.slice(0, 10).map((f) => (
                        <div key={f} className="break-all">{f}</div>
                      ))}
                      {approvalDetails.files.length > 10 ? (
                        <div className="text-[10px] text-zinc-500">+{approvalDetails.files.length - 10} more</div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {approvalDetails.riskFlags?.length ? (
                  <div className="mb-2">
                    <div className="text-[11px] font-medium text-yellow-100">Risk flags</div>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] text-yellow-50">
                      {approvalDetails.riskFlags.map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {approvalDetails.previewText ? (
                  <details>
                    <summary className="cursor-pointer select-none text-[11px] text-zinc-200">Preview artifact</summary>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[10px] text-zinc-200">
                      {approvalDetails.previewText}
                    </pre>
                  </details>
                ) : null}
              </div>
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
                {approvalBusy === 'approve'
                  ? 'Approving…'
                  : approvalKind === 'plan' || approval?.payload?.plan_artifact_id
                    ? 'Approve plan → Execute'
                    : 'Approve + Apply + Commit'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
