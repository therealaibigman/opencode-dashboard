import './env.js';

import { and, desc, eq, sql } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { makeDb } from '@ocdash/db/client';
import { artifacts, events, messages, pipelines, projects, runSteps, runs, tasks, threads } from '@ocdash/db/schema';

import { newId } from '@ocdash/shared';
import type { OcdashEvent } from '@ocdash/shared';
import { extractUnifiedDiffFromText, wrapHunkAsFilePatch } from '@ocdash/shared/patch';
import { policyCheckCommand, policyCheckPath } from '@ocdash/shared/policy';
import { prepareWorkspaceForProject } from '@ocdash/shared/workspaces';
import { validatePlanJson } from '@ocdash/shared/plan';
import { ensurePushedOrPr } from '@ocdash/shared/github';

import { requireEnv } from './env.js';
import { opencodeRun } from './opencode.js';
import { schedulerMain } from './scheduler.js';
const DATABASE_URL = requireEnv('DATABASE_URL');
const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '750');

const WORKSPACES_ROOT =
  process.env.PROJECT_WORKSPACES_ROOT ?? '/home/exedev/.openclaw/workspace/opencode-workspaces';

const REQUIRE_APPROVAL = String(process.env.OC_DASH_REQUIRE_APPROVAL ?? '') === '1';
const WORKER_ID = String(process.env.OC_DASH_WORKER_ID ?? '').trim() || `worker@${process.pid}`;

function nowIso() {
  return new Date().toISOString();
}

async function appendEventRow(db: any, ev: OcdashEvent) {
  await db.insert(events).values({
    id: ev.id,
    ts: new Date(ev.ts),
    projectId: ev.project_id ?? null,
    taskId: ev.task_id ?? null,
    threadId: ev.thread_id ?? null,
    runId: ev.run_id ?? null,
    stepId: ev.step_id ?? null,
    seq: ev.seq,
    type: ev.type,
    source: ev.source,
    severity: ev.severity,
    correlationId: ev.correlation_id ?? null,
    payload: ev.payload ?? {}
  });
}

async function getNextSeq(db: any, runId: string): Promise<number> {
  const res = await db
    .select({ max: sql<number>`coalesce(max(${events.seq}), 0)` })
    .from(events)
    .where(eq(events.runId, runId));
  return (res?.[0]?.max ?? 0) + 1;
}

const TASK_ORDER: Array<'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done'> = [
  'inbox',
  'planned',
  'in_progress',
  'blocked',
  'review',
  'done'
];

function isLaterOrEqualTaskStatus(current: string, next: string) {
  const ci = TASK_ORDER.indexOf(current as any);
  const ni = TASK_ORDER.indexOf(next as any);
  if (ci === -1 || ni === -1) return false;
  return ni <= ci;
}

async function maybeUpdateTaskStatus({
  db,
  projectId,
  taskId,
  runId,
  nextStatus
}: {
  db: any;
  projectId: string | undefined;
  taskId: string | null;
  runId?: string;
  nextStatus: 'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';
}) {
  if (!taskId) return;

  const rows = await db
    .select({ status: tasks.status, archivedAt: tasks.archivedAt })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);

  if (!rows.length) return;
  const cur = String(rows[0]!.status ?? '');
  const archivedAt = rows[0]!.archivedAt;
  if (archivedAt) return;
  if (cur === 'done') return;

  // blocked is special: always set (unless done/archived)
  if (nextStatus === 'blocked') {
    if (cur !== 'blocked') {
      await db.update(tasks).set({ status: nextStatus, updatedAt: new Date() }).where(eq(tasks.id, taskId));
      await appendEventRow(db, {
        id: newId('evt'),
        ts: nowIso(),
        seq: 0,
        type: 'task.status.changed',
        source: 'worker',
        severity: 'info',
        project_id: projectId,
        task_id: taskId,
        payload: { task_id: taskId, status: nextStatus, by: 'worker', reason: 'run.lifecycle', run_id: runId ?? null }
      });
    }
    return;
  }

  // Only move forwards in the lifecycle.
  if (isLaterOrEqualTaskStatus(cur, nextStatus)) return;

  await db.update(tasks).set({ status: nextStatus, updatedAt: new Date() }).where(eq(tasks.id, taskId));
  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: 0,
    type: 'task.status.changed',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId,
    payload: { task_id: taskId, status: nextStatus, by: 'worker', reason: 'run.lifecycle', run_id: runId ?? null }
  });
}

function clipPreview(s: string, max = 900) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)…` : s;
}

async function writeArtifact({
  db,
  projectId,
  runId,
  stepId,
  kind,
  name,
  content
}: {
  db: any;
  projectId: string | undefined;
  runId: string | undefined;
  stepId: string | undefined;
  kind: string;
  name: string;
  content: string;
}): Promise<string> {
  const id = newId('art');
  await db.insert(artifacts).values({
    id,
    projectId: projectId!,
    runId: runId!,
    stepId: stepId!,
    kind,
    name,
    contentText: content
  });
  return id;
}

async function appendThreadMessage({
  db,
  projectId,
  taskId,
  threadId,
  role,
  content
}: {
  db: any;
  projectId: string | undefined;
  taskId?: string | null;
  threadId?: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
}) {
  if (!threadId) return null;
  const id = newId('msg');
  await db.insert(messages).values({
    id,
    projectId,
    threadId,
    role,
    contentMd: content
  });
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
  return id;
}

async function createQuickStep({
  db,
  projectId,
  runId,
  name,
  status = 'succeeded',
  model,
  output
}: {
  db: any;
  projectId: string | undefined;
  runId: string | undefined;
  name: string;
  status?: 'succeeded' | 'failed';
  model?: string | null;
  output?: any;
}) {
  const id = newId('stp');
  const now = new Date();
  await db.insert(runSteps).values({
    id,
    projectId,
    runId,
    name,
    status,
    model: model ?? null,
    startedAt: now,
    finishedAt: now,
    inputJson: {},
    outputJson: output ?? {}
  });
  return id;
}


type PipelineGraph = {
  id?: string;
  nodes?: { id: string; kind?: string }[];
  edges?: [string, string][];
};

function pipelineTopoWaves(graph: PipelineGraph): string[][] {
  const nodes = (graph.nodes ?? []).map((n) => String(n.id));
  const edges = (graph.edges ?? []).map((e) => [String(e[0]), String(e[1])] as [string, string]);

  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n, 0);
    out.set(n, []);
  }
  for (const [a, b] of edges) {
    if (!indeg.has(a) || !indeg.has(b)) continue;
    out.get(a)!.push(b);
    indeg.set(b, (indeg.get(b) ?? 0) + 1);
  }

  const waves: string[][] = [];
  const q: string[] = [];
  for (const [n, d] of indeg) if (d === 0) q.push(n);

  const seen = new Set<string>();
  while (q.length) {
    const wave = q.splice(0, q.length);
    waves.push(wave);
    for (const n of wave) {
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of out.get(n) ?? []) {
        indeg.set(m, (indeg.get(m) ?? 0) - 1);
      }
    }
    for (const [n, d] of indeg) {
      if (d === 0 && !seen.has(n) && !q.includes(n)) q.push(n);
    }
  }

  // If graph has cycles or missing links, just return single wave with nodes (best effort).
  if (seen.size !== nodes.length) {
    return [nodes];
  }

  return waves.length ? waves : [nodes];
}
async function isRunCancelled(db: any, runId: string): Promise<boolean> {
  const rows = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).limit(1);
  return rows?.[0]?.status === 'cancelled';
}

async function runCmd({
  cwd,
  cmd,
  timeoutMs = 10 * 60 * 1000
}: {
  cwd: string;
  cmd: string;
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const dec = policyCheckCommand(cmd);
  if (!dec.ok) return { exitCode: 126, stdout: '', stderr: `[policy] ${dec.reason}` };

  const [bin, ...args] = cmd.split(/\s+/);
  return await new Promise((resolve) => {
    const child = spawn(bin!, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    const t = setTimeout(() => {
      stderr += `\n[worker] timeout after ${timeoutMs}ms`;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${String(err)}` });
    });
  });
}


async function fileExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitRepo(ws: string) {
  const gitDir = path.join(ws, '.git');
  if (!(await fileExists(gitDir))) {
    await runCmd({ cwd: ws, cmd: 'git init' });
  }

  await runCmd({ cwd: ws, cmd: 'git config user.email ocdash@local' });
  await runCmd({ cwd: ws, cmd: 'git config user.name ocdash' });
}

async function ensureReadme(ws: string) {
  const p = path.join(ws, 'README.md');
  if (!(await fileExists(p))) {
    await fs.writeFile(p, '# Project\n', 'utf8');
  }
}



async function processPublishRun({ db, runId, runRow }: { db: any; runId: string; runRow: any }) {
  const projectId = runRow?.projectId as string | undefined;
  const taskId = (runRow?.taskId as string | null | undefined) ?? null;
  const threadId = ((runRow as any)?.threadId as string | null | undefined) ?? null;

  if (!projectId) throw new Error(`Run ${runId} missing projectId`);

  // Mark running and set heartbeat.
  await db
    .update(runs)
    .set({ status: 'running', startedAt: new Date(), workerId: WORKER_ID, heartbeatAt: new Date() } as any)
    .where(and(eq(runs.id, runId), eq(runs.status, 'claimed' as any)));

  // Heartbeat while publishing (best-effort)
  let hbStop = false;
  const hbTimer = setInterval(() => {
    void (async () => {
      if (hbStop) return;
      try {
        await db.update(runs).set({ heartbeatAt: new Date() } as any).where(eq(runs.id, runId));
      } catch {
        // ignore
      }
    })();
  }, Number(process.env.OC_DASH_HEARTBEAT_MS ?? '2000'));

  try {
    const projRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    const proj = projRows[0];
    const baseBranch = String((proj as any)?.defaultBranch ?? 'main') || 'main';

    const prep = await prepareWorkspaceForProject({
      root: WORKSPACES_ROOT,
      project: {
        id: projectId,
        localPath: (proj as any)?.localPath,
        repoUrl: (proj as any)?.repoUrl,
        defaultBranch: (proj as any)?.defaultBranch
      }
    });
    const ws = prep.workspace;

    await ensureGitRepo(ws);

    // Commit whatever is currently in the workspace.
    await runCmd({ cwd: ws, cmd: 'git add -A' });
    const commitMsg = `ocdash: publish for ${taskId ?? runId}`;
    const commitRes = await runCmd({ cwd: ws, cmd: `git commit -m "${commitMsg.replace(/"/g, "'")}"` });

    const cOut = await writeArtifact({ db, projectId, runId, stepId: 'stp_publish', kind: 'stdout', name: 'git commit stdout', content: (commitRes.stdout ?? '') as string });
    const cErr = await writeArtifact({ db, projectId, runId, stepId: 'stp_publish', kind: 'stderr', name: 'git commit stderr', content: (commitRes.stderr ?? '') as string });

    if (commitRes.exitCode !== 0) {
      const msg = String(commitRes.stderr ?? commitRes.stdout ?? 'git commit failed');
      // If nothing changed, treat as success but note it.
      if (msg.toLowerCase().includes('nothing to commit')) {
        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Publish: nothing to commit.' });
        await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() } as any).where(eq(runs.id, runId));
        return;
      }

      await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Publish failed at git commit: ${msg}` });
      await db.update(runs).set({ status: 'failed', finishedAt: new Date() } as any).where(eq(runs.id, runId));
      return;
    }

    const taskTitle = taskId
      ? String((await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]?.title ?? '')
      : '';

    const prTitle = `ocdash: ${taskTitle || taskId || runId}`;
    const prBody = `Automated changes from OpenCode Dashboard.

Run: ${runId}
Project: ${projectId}
Task: ${taskId ?? '(none)'}
`;

    const prRes = await ensurePushedOrPr({ ws, runId, baseBranch, title: prTitle, body: prBody });

    if (!prRes.ok) {
      await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Publish failed: ${prRes.error ?? 'unknown error'}` });
      await db.update(runs).set({ status: 'failed', finishedAt: new Date() } as any).where(eq(runs.id, runId));
      return;
    }

    if (prRes.mode === 'pr') {
      await db
        .update(runs)
        .set({ prUrl: prRes.url, prBranch: prRes.branch, prNumber: prRes.number ?? null, prRepo: prRes.repo ?? null, prState: prRes.state ?? null } as any)
        .where(eq(runs.id, runId));
      const prArtId = await writeArtifact({ db, projectId, runId, stepId: 'stp_publish', kind: 'github_pr', name: 'GitHub PR', content: prRes.url + '\n' });
      await appendEventRow(db, {
        id: newId('evt'),
        ts: nowIso(),
        seq: 0,
        type: 'tool.call.completed',
        source: 'worker',
        severity: 'info',
        project_id: projectId,
        task_id: taskId ?? undefined,
        run_id: runId,
        step_id: 'stp_publish',
        payload: { tool: 'github.pr.create', url: prRes.url, branch: prRes.branch, number: prRes.number ?? null, repo: prRes.repo ?? null, state: prRes.state ?? null, artifact_id: prArtId }
      });
      await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Published: PR ${prRes.url}` });
    } else {
      await db.update(runs).set({ prUrl: null, prBranch: prRes.branch, prNumber: null, prRepo: null, prState: 'pushed' } as any).where(eq(runs.id, runId));
      await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Published: pushed branch ${prRes.branch}` });
    }

    if (taskId) {
      await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'done' });
    }

    await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() } as any).where(eq(runs.id, runId));

  } finally {
    hbStop = true;
    try { clearInterval(hbTimer); } catch {}
  }
}

async function processReviewRun({ db, runId, runRow }: { db: any; runId: string; runRow: any }) {
  const projectId = runRow?.projectId as string | undefined;
  const taskId = (runRow?.taskId as string | null | undefined) ?? null;
  const threadId = ((runRow as any)?.threadId as string | null | undefined) ?? null;
  const parentRunId = ((runRow as any)?.parentRunId as string | null | undefined) ?? null;

  if (!projectId) throw new Error(`Run ${runId} missing projectId`);

  // Mark running and set heartbeat.
  await db
    .update(runs)
    .set({ status: 'running', startedAt: new Date(), workerId: WORKER_ID, heartbeatAt: new Date() } as any)
    .where(and(eq(runs.id, runId), eq(runs.status, 'claimed' as any)));

  // Heartbeat while reviewing (best-effort)
  let hbStop = false;
  const hbTimer = setInterval(() => {
    void (async () => {
      if (hbStop) return;
      try {
        await db.update(runs).set({ heartbeatAt: new Date() } as any).where(eq(runs.id, runId));
      } catch {
        // ignore
      }
    })();
  }, Number(process.env.OC_DASH_HEARTBEAT_MS ?? '2000'));

  // Fetch the patch (if any) from the parent execute run.
  let patchText = '';
  if (parentRunId) {
    const prow = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, parentRunId), eq(artifacts.kind, 'patch')))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    patchText = String(prow?.[0]?.contentText ?? '');
  }

  const clipped = clipPreview(patchText, 8000);

  // Ask OpenCode to behave like a reviewer and emit a strict JSON verdict.
  const prompt =
    `You are the reviewer. Review the proposed changes (unified diff) and decide if they are acceptable.
` +
    `Return ONLY a JSON object with:
` +
    `- verdict: "pass" | "changes_requested"
` +
    `- must_fix: string[]
` +
    `- suggestions: string[]
` +
    `- notes: string

` +
    (clipped.trim()
      ? `Diff:

\`\`\`diff
${clipped}
\`\`\`
`
      : `No diff was produced by the execute run. Return verdict="pass" with a note.`);

  const projRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const proj = projRows[0];
  const prep = await prepareWorkspaceForProject({
    root: WORKSPACES_ROOT,
    project: {
      id: projectId,
      localPath: (proj as any)?.localPath,
      repoUrl: (proj as any)?.repoUrl,
      defaultBranch: (proj as any)?.defaultBranch
    }
  });
  const ws = prep.workspace;

  const result = await opencodeRun({
    cwd: ws,
    message: prompt,
    timeoutMs: Number(process.env.OPENCODE_TIMEOUT_MS ?? '600000'),
    model: (process.env.OPENCODE_MODEL ?? '').trim() || undefined
  });

  const verdictText = result.exitCode === 0 ? (result.stdout || '').trim() : '';
  const content = verdictText || JSON.stringify({ verdict: 'changes_requested', must_fix: ['review tool failed'], suggestions: [], notes: result.stderr || '' }, null, 2);

  const stepId = 'stp_review';
  const artId = await writeArtifact({
    db,
    projectId,
    runId,
    stepId,
    kind: 'review_verdict',
    name: 'review verdict',
    content
  });

  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: 0,
    type: 'artifact.created',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    run_id: runId,
    step_id: stepId,
    payload: { artifact: { id: artId, kind: 'review_verdict', name: 'review verdict' }, parent_run_id: parentRunId }
  });

  await appendThreadMessage({
    db,
    projectId,
    taskId,
    threadId,
    role: 'assistant',
    content: `Review complete. Verdict artifact: ${artId}`
  });

  await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() } as any).where(eq(runs.id, runId));

  hbStop = true;
  try {
    clearInterval(hbTimer);
  } catch {
    // ignore
  }
}


async function processRun(db: any, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const runRow = runRows[0];
  const projectId = runRow?.projectId as string | undefined;
  const taskId = (runRow?.taskId as string | null | undefined) ?? null;
  const threadId = ((runRow as any)?.threadId as string | null | undefined) ?? null;
  const pipelineId = ((runRow as any)?.pipelineId as string | null | undefined) ?? null;
  const kind = (runRow as any)?.kind ?? 'execute';

  if (!projectId) throw new Error(`Run ${runId} missing projectId`);

  if (runRow?.status === 'cancelled') return;

  if (kind === 'review') {
    await processReviewRun({ db, runId, runRow });
    return;
  }

  if (kind === 'publish') {
    await processPublishRun({ db, runId, runRow });
    return;
  }

  // Heartbeat: mark liveness so a future scheduler can reap stuck runs.
  let hbStop = false;
  const hbTimer = setInterval(() => {
    void (async () => {
      if (hbStop) return;
      try {
        await db.update(runs).set({ heartbeatAt: new Date() } as any).where(eq(runs.id, runId));
      } catch {
        // ignore
      }
    })();
  }, Number(process.env.OC_DASH_HEARTBEAT_MS ?? '2000'));

  try {

  const projRows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const proj = projRows[0];
  const baseBranch = String((proj as any)?.defaultBranch ?? 'main') || 'main';

  let taskTitle = '';
  let taskBody = '';
  if (taskId) {
    const trows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (trows.length) {
      taskTitle = trows[0]!.title;
      taskBody = trows[0]!.bodyMd;
    }
  }

  let seq = await getNextSeq(db, runId);

  let pipelineGraph: any = null;
  const pipelineStepByKind = new Map<string, string>();
  const pipelineStepByNode = new Map<string, string>();

  if (pipelineId) {
    try {
      const prows = await db.select().from(pipelines).where(eq(pipelines.id, pipelineId)).limit(1);
      const row = prows[0] as any;
      pipelineGraph = (row?.graphJson ?? row?.graph_json ?? null) as any;

      const pname = row?.name ? String(row.name) : pipelineId;
      await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Pipeline: ${pname}` });

      const nodes: { id: string; kind?: string }[] = Array.isArray(pipelineGraph?.nodes) ? pipelineGraph.nodes : [];
      const waves = pipelineTopoWaves(pipelineGraph ?? {});
      const waveIndexByNode = new Map<string, number>();
      for (let wi = 0; wi < waves.length; wi++) {
        for (const nid of waves[wi] ?? []) waveIndexByNode.set(String(nid), wi);
      }

      // Pre-create run_steps rows for each pipeline node (queued).
      for (const n of nodes) {
        const nodeId = String((n as any)?.id ?? '').trim();
        if (!nodeId) continue;
        const nodeKind = String((n as any)?.kind ?? nodeId).trim() || nodeId;
        const sid = newId('stp');
        await db.insert(runSteps).values({
          id: sid,
          projectId,
          runId,
          name: nodeKind,
          status: 'queued',
          model: null,
          inputJson: { pipeline_node_id: nodeId, pipeline_kind: nodeKind, wave: waveIndexByNode.get(nodeId) ?? 0 },
          outputJson: {}
        });
        pipelineStepByNode.set(nodeId, sid);
        if (!pipelineStepByKind.has(nodeKind)) pipelineStepByKind.set(nodeKind, sid);
      }
    } catch {
      // ignore pipeline bootstrap failures
    }
  }


  // GSD pipeline execution handled later (after model/step ids are established).


  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: seq++,
    type: 'run.started',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    run_id: runId,
    payload: { message: 'Run started', kind, worker_id: WORKER_ID }
  });

  // Task lifecycle projection
  await maybeUpdateTaskStatus({
    db,
    projectId,
    taskId,
    runId,
    nextStatus: kind === 'plan' ? 'planned' : 'in_progress'
  });


  let stepId = newId('stp');

  await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run started (${kind}).` });

  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: seq++,
    type: 'run.step.started',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    run_id: runId,
    step_id: stepId,
    payload: { step: { name: 'opencode.run', kind: 'tool' }, message: 'Preparing workspace' }
  });

  const prep = await prepareWorkspaceForProject({
    root: WORKSPACES_ROOT,
    project: {
      id: projectId,
      localPath: (proj as any)?.localPath,
      repoUrl: (proj as any)?.repoUrl,
      defaultBranch: (proj as any)?.defaultBranch
    }
  });

  const ws = prep.workspace;

  await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run started (${kind}).` });

  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: seq++,
    type: 'run.step.progress',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    run_id: runId,
    step_id: stepId,
    payload: {
      message: `Workspace ready (${prep.mode}) at ${ws}`,
      workspace_mode: prep.mode,
      local_path: (proj as any)?.localPath ?? null,
      repo_url: (proj as any)?.repoUrl ?? null,
      default_branch: (proj as any)?.defaultBranch ?? null
    }
  });

  await ensureGitRepo(ws);
  await ensureReadme(ws);

    // If an approved plan is attached to this execute run, include it as context.
  let approvedPlanJson = '';
  try {
    const planRows = await db
      .select({ contentText: artifacts.contentText })
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'plan')))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);
    if (planRows.length) approvedPlanJson = String(planRows[0]!.contentText ?? '').trim();
  } catch {
    // ignore
  }

  // If there is a recent review verdict for this task, include it as context (ralph loop).
  let latestReviewVerdictJson = '';
  try {
    if (taskId) {
      const rrows = await db.execute(sql`
        SELECT a.content_text
        FROM artifacts a
        JOIN runs r ON r.id = a.run_id
        WHERE r.project_id = ${projectId}
          AND r.task_id = ${taskId}
          AND r.kind = 'review'::run_kind
          AND a.kind = 'review_verdict'
        ORDER BY a.created_at DESC
        LIMIT 1
      `);
      const rows = (rrows as any)?.rows ?? rrows;
      if (Array.isArray(rows) && rows.length) latestReviewVerdictJson = String(rows[0]?.content_text ?? '').trim();
    }
  } catch {
    // ignore
  }

const baseTask = taskId ? `Task: ${taskTitle}\n\nDetails:\n${taskBody}` : `Project ${projectId}`;

  const msg =
    kind === 'plan'
      ? `${baseTask}\n\nYou are planning work. Output a plan as JSON inside a fenced \`\`\`json block with:\n{\n  \"summary\": string,\n  \"steps\": [{\"title\": string, \"details\": string, \"risk\": \"low\"|\"med\"|\"high\"}],\n  \"files\": string[],\n  \"commands\": string[]\n}\n\nDo NOT output a diff. Do NOT execute anything.\n`
      : `${baseTask}\n\n${approvedPlanJson ? `Approved plan (JSON):\n\n\`\`\`json\n${approvedPlanJson}\n\`\`\`\n\nFollow the approved plan.\n\n` : ''}${latestReviewVerdictJson ? `Latest review verdict (JSON):

\`\`\`json
${latestReviewVerdictJson}
\`\`\`

Address all must_fix items.

` : ''}Return a unified diff in a fenced \`\`\`diff block if code changes are needed. Include full diff headers (diff --git, ---/+++).\n\nDo the next best action.`;

  const direct = String(runRow?.modelProfile ?? '').trim();
  const directModel = direct.includes('/') ? direct : '';
  const model = (directModel || (kind === 'plan' ? String((proj as any)?.planModel ?? '') : String((proj as any)?.executeModel ?? '')) || (process.env.OPENCODE_MODEL ?? '')).trim() || undefined;
  const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS ?? '600000');

  const stepName = kind === 'plan' ? 'plan' : 'execute';

  // If this run uses a pipeline template, bind the opencode step to the pre-created pipeline node step id.
  stepId = pipelineStepByKind.get(stepName) ?? stepId;

  const existingStep = await db.select({ id: runSteps.id }).from(runSteps).where(eq(runSteps.id, stepId)).limit(1);
  if (existingStep.length) {
    await db.update(runSteps).set({ status: 'running', model: model ?? null, startedAt: new Date(), inputJson: { kind, pipeline: Boolean(pipelineId) } }).where(eq(runSteps.id, stepId));
  } else {
    await db.insert(runSteps).values({
      id: stepId,
      projectId,
      runId,
      name: stepName,
      status: 'running',
      model: model ?? null,
      startedAt: new Date(),
      inputJson: { kind },
      outputJson: {}
    });
  }

  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: seq++,
    type: 'run.step.started',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    thread_id: threadId ?? undefined,
    run_id: runId,
    step_id: stepId,
    payload: { name: stepName, model: model ?? null }
  });

  await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run started (${kind}).` });

  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: seq++,
    type: 'tool.call.requested',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    run_id: runId,
    step_id: stepId,
    payload: {
      tool: 'opencode.run',
      args: {
        cwd: ws,
        message: taskId ? taskTitle : '(no task)',
        model: model ?? null,
        timeout_ms: timeoutMs,
        kind
      }
    }
  });

  const controller = new AbortController();
  let cancelled = false;
  const cancelTimer = setInterval(() => {
    void (async () => {
      try {
        if (!cancelled && (await isRunCancelled(db, runId))) {
          cancelled = true;
          controller.abort();
        }
      } catch {
        // ignore
      }
    })();
  }, 1000);

  let lastProgressAt = 0;
  let tail = '';
  const maybeEmitProgress = async () => {
    if (cancelled || controller.signal.aborted) return;

    const now = Date.now();
    if (now - lastProgressAt < 650) return;
    lastProgressAt = now;

    const text = tail.trim();
    if (!text) return;

    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'run.step.progress',
      source: 'worker',
      severity: 'info',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      step_id: stepId,
      payload: { message: clipPreview(text, 900) }
    });

    tail = '';
  };

  const result = await opencodeRun({
    cwd: ws,
    message: msg,
    model,
    timeoutMs,
    signal: controller.signal,
    onStdout: (chunk) => {
      if (cancelled || controller.signal.aborted) return;
      tail += chunk;
      if (tail.length > 2000) tail = tail.slice(-2000);
      void maybeEmitProgress();
    },
    onStderr: (chunk) => {
      if (cancelled || controller.signal.aborted) return;
      tail += chunk;
      if (tail.length > 2000) tail = tail.slice(-2000);
      void maybeEmitProgress();
    }
  });

  clearInterval(cancelTimer);
  cancelled = cancelled || result.cancelled === true;

  if (!cancelled) await maybeEmitProgress();

  const stdoutId = await writeArtifact({
    db,
    projectId: projectId!,
    runId: runId!,
    stepId: stepId!,
    kind: 'stdout',
    name: 'opencode stdout',
    content: result.stdout ?? ''
  });

  const stderrId = await writeArtifact({
    db,
    projectId: projectId!,
    runId: runId!,
    stepId: stepId!,
    kind: 'stderr',
    name: 'opencode stderr',
    content: result.stderr ?? ''
  });

  await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run started (${kind}).` });

  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: seq++,
    type: 'artifact.created',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    run_id: runId,
    step_id: stepId,
    payload: { artifact: { id: stdoutId, kind: 'stdout', name: 'opencode stdout' } }
  });

  await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run started (${kind}).` });

  await appendEventRow(db, {
    id: newId('evt'),
    ts: nowIso(),
    seq: seq++,
    type: 'artifact.created',
    source: 'worker',
    severity: 'info',
    project_id: projectId,
    task_id: taskId ?? undefined,
    run_id: runId,
    step_id: stepId,
    payload: { artifact: { id: stderrId, kind: 'stderr', name: 'opencode stderr' } }
  });

  if (cancelled) {
    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'run.cancelled',
      source: 'worker',
      severity: 'warn',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      payload: { message: 'Run cancelled' }
    });

    await db.update(runs).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(runs.id, runId));
    return;
  }

  if (kind === 'plan') {
    // Extract JSON plan block.
    const m = (result.stdout ?? '').match(/```json\s*([\s\S]*?)```/m);
    const planText = m?.[1]?.trim() ?? '';
    const v = planText ? validatePlanJson(planText) : null;
    if (planText) {
      const planArtifactId = await writeArtifact({
        db,
        projectId,
        runId,
        stepId,
        kind: 'plan',
        name: 'proposed plan',
        content: planText + '\n'
      });

      await appendEventRow(db, {
        id: newId('evt'),
        ts: nowIso(),
        seq: seq++,
        type: 'artifact.created',
        source: 'worker',
        severity: 'info',
        project_id: projectId,
        task_id: taskId ?? undefined,
        run_id: runId,
        step_id: stepId,
        payload: { artifact: { id: planArtifactId, kind: 'plan', name: 'proposed plan' } }
      });

      await db.update(runs).set({ status: 'needs_approval' }).where(eq(runs.id, runId));
      await appendEventRow(db, {
        id: newId('evt'),
        ts: nowIso(),
        seq: seq++,
        type: 'approval.requested',
        source: 'worker',
        severity: 'warn',
        project_id: projectId,
        task_id: taskId ?? undefined,
        run_id: runId,
        payload: { reason: v && !v.ok ? `plan approval required (invalid format: ${v.error})` : 'plan approval required', plan_artifact_id: planArtifactId }
      });

        if (kind === 'execute') {
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'review' });
        }

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Approval required. Approve or reject in the dashboard to continue.' });
      return;
    }

    await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'run.failed',
      source: 'worker',
      severity: 'error',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      payload: { message: 'Plan run failed: no json block produced' }
    });

        await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'blocked' });

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Run failed. Check timeline/artifacts for details.' });
    return;
  }

  // execute kind (existing approval gate)
  const patch = extractUnifiedDiffFromText(result.stdout ?? '');

  if (REQUIRE_APPROVAL && !patch) {
    await db.update(runs).set({ status: 'needs_approval' }).where(eq(runs.id, runId));
    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'approval.requested',
      source: 'worker',
      severity: 'warn',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      payload: { reason: 'OC_DASH_REQUIRE_APPROVAL=1 but no diff produced', stdout_artifact_id: stdoutId }
    });

        if (kind === 'execute') {
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'review' });
        }

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Approval required. Approve or reject in the dashboard to continue.' });
    return;
  }

  if (patch) {
    const normalizedPatchText =
      !patch.hasGitHeaders && patch.patchText.trimStart().startsWith('@@')
        ? wrapHunkAsFilePatch({ patchText: patch.patchText, filePath: 'README.md' })
        : patch.patchText;

    if (!normalizedPatchText.trim()) {
      if (REQUIRE_APPROVAL) {
        await db.update(runs).set({ status: 'needs_approval' }).where(eq(runs.id, runId));
        await appendEventRow(db, {
          id: newId('evt'),
          ts: nowIso(),
          seq: seq++,
          type: 'approval.requested',
          source: 'worker',
          severity: 'warn',
          project_id: projectId,
          task_id: taskId ?? undefined,
          run_id: runId,
          payload: { reason: 'diff block was empty', stdout_artifact_id: stdoutId }
        });

        if (kind === 'execute') {
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'review' });
        }

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Approval required. Approve or reject in the dashboard to continue.' });
        return;
      }
    } else {
      const patchArtifactId = await writeArtifact({
        db,
        projectId,
        runId,
        stepId,
        kind: 'patch',
        name: 'proposed patch',
        content: normalizedPatchText
      });

      await appendEventRow(db, {
        id: newId('evt'),
        ts: nowIso(),
        seq: seq++,
        type: 'artifact.created',
        source: 'worker',
        severity: 'info',
        project_id: projectId,
        task_id: taskId ?? undefined,
        run_id: runId,
        step_id: stepId,
        payload: { artifact: { id: patchArtifactId, kind: 'patch', name: 'proposed patch' } }
      });

      if (REQUIRE_APPROVAL) {
        await db.update(runs).set({ status: 'needs_approval' }).where(eq(runs.id, runId));
        await appendEventRow(db, {
          id: newId('evt'),
          ts: nowIso(),
          seq: seq++,
          type: 'approval.requested',
          source: 'worker',
          severity: 'warn',
          project_id: projectId,
          task_id: taskId ?? undefined,
          run_id: runId,
          payload: { reason: 'OC_DASH_REQUIRE_APPROVAL=1', patch_artifact_id: patchArtifactId }
        });

        if (kind === 'execute') {
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'review' });
        }

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Approval required. Approve or reject in the dashboard to continue.' });
        return;
      }

      const touchedPaths = patch.touchedPaths.length ? patch.touchedPaths : ['README.md'];
      for (const p of touchedPaths) {
        const dec = policyCheckPath({ workspace: ws, filePath: p });
        if (!dec.ok) {
          await db.update(runs).set({ status: 'needs_approval' }).where(eq(runs.id, runId));

          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'approval.requested',
            source: 'worker',
            severity: 'warn',
            project_id: projectId,
            task_id: taskId ?? undefined,
            run_id: runId,
            payload: { reason: dec.reason, patch_artifact_id: patchArtifactId }
          });

        if (kind === 'execute') {
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'review' });
        }

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Approval required. Approve or reject in the dashboard to continue.' });

          return;
        }


      }

      // Pipeline DAG execution (v2): dependency-driven scheduler with safe parallel waves.
      if (pipelineId && pipelineGraph) {
        const nodes: { id: string; kind: string }[] = Array.isArray((pipelineGraph as any)?.nodes)
          ? (pipelineGraph as any).nodes
              .map((n: any) => ({ id: String(n?.id ?? '').trim(), kind: String(n?.kind ?? n?.id ?? '').trim() }))
              .filter((n: any) => n.id && n.kind)
          : [];
        const edges: [string, string][] = Array.isArray((pipelineGraph as any)?.edges)
          ? (pipelineGraph as any).edges.map((e: any) => [String(e?.[0] ?? ''), String(e?.[1] ?? '')] as [string, string])
          : [];

        const deps = new Map<string, Set<string>>();
        const out = new Map<string, Set<string>>();
        for (const n of nodes) {
          deps.set(n.id, new Set());
          out.set(n.id, new Set());
        }
        for (const [a, b] of edges) {
          if (!deps.has(a) || !deps.has(b)) continue;
          deps.get(b)!.add(a);
          out.get(a)!.add(b);
        }

        const nodeKindById = new Map(nodes.map((n) => [n.id, n.kind] as const));
        const waves = pipelineTopoWaves({ nodes: nodes.map((n) => ({ id: n.id })), edges });
        const waveIndexByNode = new Map<string, number>();
        for (let wi = 0; wi < waves.length; wi++) for (const nid of waves[wi] ?? []) waveIndexByNode.set(String(nid), wi);

        const writesWorkspace = (kind: string) => kind === 'execute' || kind === 'publish';

        async function upsertStepRunning(stepId: string, name: string, input: any) {
          const existing = await db.select({ id: runSteps.id }).from(runSteps).where(eq(runSteps.id, stepId)).limit(1);
          if (existing.length) {
            await db.update(runSteps).set({ status: 'running', startedAt: new Date(), inputJson: input ?? {} }).where(eq(runSteps.id, stepId));
          } else {
            await db.insert(runSteps).values({ id: stepId, projectId, runId, name, status: 'running', startedAt: new Date(), inputJson: input ?? {}, outputJson: {} });
          }

          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'run.step.started',
            source: 'worker',
            severity: 'info',
            project_id: projectId,
            task_id: taskId ?? undefined,
            thread_id: threadId ?? undefined,
            run_id: runId,
            step_id: stepId,
            payload: { name }
          });
        }

        async function stepSucceed(stepId: string, name: string, output: any) {
          await db.update(runSteps).set({ status: 'succeeded', finishedAt: new Date(), outputJson: output ?? {} }).where(eq(runSteps.id, stepId));
          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'run.step.completed',
            source: 'worker',
            severity: 'info',
            project_id: projectId,
            task_id: taskId ?? undefined,
            thread_id: threadId ?? undefined,
            run_id: runId,
            step_id: stepId,
            payload: { name }
          });
        }

        async function stepFail(stepId: string, name: string, message: string, payload: any = {}) {
          await db.update(runSteps).set({ status: 'failed', finishedAt: new Date(), outputJson: { message, ...(payload ?? {}) } }).where(eq(runSteps.id, stepId));
          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'run.step.failed',
            source: 'worker',
            severity: 'error',
            project_id: projectId,
            task_id: taskId ?? undefined,
            run_id: runId,
            step_id: stepId,
            payload: { message, ...(payload ?? {}) }
          });
        }

        async function runNode(nodeId: string) {
          const kind = nodeKindById.get(nodeId) ?? nodeId;
          const stepIdForNode = pipelineStepByNode.get(nodeId) ?? pipelineStepByKind.get(kind) ?? newId('stp');

          if (await isRunCancelled(db, runId)) {
            throw new Error('cancelled');
          }

          // Intake/plan are context-only for now.
          if (kind === 'intake' || kind === 'plan') {
            await upsertStepRunning(stepIdForNode, kind, { pipeline_node_id: nodeId, wave: waveIndexByNode.get(nodeId) ?? 0 });
            await stepSucceed(stepIdForNode, kind, { ok: true });
            return;
          }

          if (kind === 'execute') {
            // Note: opencode.run already happened earlier; this node applies the patch to the workspace.
            await upsertStepRunning(stepIdForNode, 'execute', { pipeline_node_id: nodeId, wave: waveIndexByNode.get(nodeId) ?? 0, stage: 'apply' });

            if (!normalizedPatchText.trim()) {
              await stepSucceed(stepIdForNode, 'execute', { ok: true, note: 'no patch' });
              return;
            }

            const patchFile = path.join(ws, `.ocdash_pipe_${Date.now()}.diff`);
            await fs.writeFile(patchFile, normalizedPatchText, 'utf8');

            let applyRes = await runCmd({ cwd: ws, cmd: `git apply ${patchFile}` });
            let method = 'git apply';
            if (applyRes.exitCode !== 0) {
              const p2 = await runCmd({ cwd: ws, cmd: `patch -p1 --forward --batch -i ${patchFile}` });
              method = 'patch -p1';
              applyRes = {
                exitCode: p2.exitCode,
                stdout: `${applyRes.stdout}
---
[fallback patch stdout]
${p2.stdout}`,
                stderr: `${applyRes.stderr}
---
[fallback patch stderr]
${p2.stderr}`
              };
            }

            const applyOutId = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'stdout', name: `apply patch stdout (${method})`, content: (applyRes.stdout ?? '') as string });
            const applyErrId = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'stderr', name: `apply patch stderr (${method})`, content: (applyRes.stderr ?? '') as string });

            if (applyRes.exitCode !== 0) {
              await stepFail(stepIdForNode, 'execute', 'patch apply failed', { stdout_artifact_id: applyOutId, stderr_artifact_id: applyErrId, method });
              throw new Error('execute failed');
            }

            await stepSucceed(stepIdForNode, 'execute', { ok: true, method, stdout_artifact_id: applyOutId, stderr_artifact_id: applyErrId });
            return;
          }

          if (kind === 'checks') {
            const autoCmdsRaw = String(process.env.OC_DASH_AUTO_COMMANDS ?? '').trim();
            const cmds = autoCmdsRaw
              ? autoCmdsRaw.split(',').map((x) => x.trim()).filter(Boolean)
              : ['npm test', 'npm run lint', 'npm run typecheck'];

            await upsertStepRunning(stepIdForNode, 'checks', { pipeline_node_id: nodeId, wave: waveIndexByNode.get(nodeId) ?? 0, cmds });

            const hasPkg = await fileExists(path.join(ws, 'package.json'));
            if (!hasPkg) {
              await appendEventRow(db, {
                id: newId('evt'),
                ts: nowIso(),
                seq: seq++,
                type: 'run.step.progress',
                source: 'worker',
                severity: 'info',
                project_id: projectId,
                task_id: taskId ?? undefined,
                run_id: runId,
                step_id: stepIdForNode,
                payload: { message: 'No package.json; skipping checks.' }
              });
              await stepSucceed(stepIdForNode, 'checks', { ok: true, skipped: true });
              return;
            }

            const limit = 2;
            let cidx = 0;
            let failed: { cmd: string; outId: string; errId: string; exitCode: number } | null = null;
            const runOne = async () => {
              while (true) {
                const i = cidx++;
                const cmd = cmds[i];
                if (!cmd) return;
                if (failed) return;
                const res = await runCmd({ cwd: ws, cmd });
                const outId = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'stdout', name: `${cmd} stdout`, content: (res.stdout ?? '') as string });
                const errId = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'stderr', name: `${cmd} stderr`, content: (res.stderr ?? '') as string });
                if (res.exitCode !== 0 && !failed) {
                  failed = { cmd, outId, errId, exitCode: res.exitCode };
                  return;
                }
              }
            };
            const workers = Array.from({ length: Math.max(1, Math.min(limit, cmds.length)) }, () => runOne());
            await Promise.all(workers);
            const f = failed as unknown as { cmd: string; outId: string; errId: string; exitCode: number } | null;
            if (f) {
              await stepFail(stepIdForNode, 'checks', `checks failed: ${f.cmd}`, { cmd: f.cmd, exit_code: f.exitCode, stdout_artifact_id: f.outId, stderr_artifact_id: f.errId });
              throw new Error('checks failed');
            }

            await stepSucceed(stepIdForNode, 'checks', { ok: true });
            return;
          }

          if (kind === 'publish') {
            await upsertStepRunning(stepIdForNode, 'publish', { pipeline_node_id: nodeId, wave: waveIndexByNode.get(nodeId) ?? 0, baseBranch });

            await runCmd({ cwd: ws, cmd: 'git add -A' });
            const commitMsg = `ocdash: auto-apply for ${taskId ?? runId}`;
            const commitRes = await runCmd({ cwd: ws, cmd: `git commit -m "${commitMsg.replace(/"/g, "'")}"` });
            const cOut = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'stdout', name: 'git commit stdout', content: (commitRes.stdout ?? '') as string });
            const cErr = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'stderr', name: 'git commit stderr', content: (commitRes.stderr ?? '') as string });
            if (commitRes.exitCode !== 0) {
              await stepFail(stepIdForNode, 'publish', 'git commit failed', { stdout_artifact_id: cOut, stderr_artifact_id: cErr });
              throw new Error('publish failed');
            }

            const prTitle = `ocdash: ${taskTitle || taskId || runId}`;
            const prBody = `Automated changes from OpenCode Dashboard.

Run: ${runId}
Project: ${projectId}
Task: ${taskId ?? '(none)'}
`;
            const prRes = await ensurePushedOrPr({ ws, runId, baseBranch, title: prTitle, body: prBody });

            if (prRes.ok) {
              if (prRes.mode === 'pr') {
                await db.update(runs)
                  .set({ prUrl: prRes.url, prBranch: prRes.branch, prNumber: prRes.number ?? null, prRepo: prRes.repo ?? null, prState: prRes.state ?? null })
                  .where(eq(runs.id, runId));
                const prArtId = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'github_pr', name: 'GitHub PR', content: prRes.url + '\n' });
                await appendEventRow(db, {
                  id: newId('evt'),
                  ts: nowIso(),
                  seq: seq++,
                  type: 'tool.call.completed',
                  source: 'worker',
                  severity: 'info',
                  project_id: projectId,
                  task_id: taskId ?? undefined,
                  run_id: runId,
                  step_id: stepIdForNode,
                  payload: { tool: 'github.pr.create', url: prRes.url, branch: prRes.branch, number: prRes.number ?? null, repo: prRes.repo ?? null, state: prRes.state ?? null, artifact_id: prArtId }
                });
                await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Published: PR ${(prRes as any).url}` });
              } else {
                await db.update(runs).set({ prUrl: null, prBranch: prRes.branch, prNumber: null, prRepo: null, prState: 'pushed' }).where(eq(runs.id, runId));
                await appendEventRow(db, {
                  id: newId('evt'),
                  ts: nowIso(),
                  seq: seq++,
                  type: 'tool.call.completed',
                  source: 'worker',
                  severity: 'info',
                  project_id: projectId,
                  task_id: taskId ?? undefined,
                  run_id: runId,
                  step_id: stepIdForNode,
                  payload: { tool: 'github.push.initial', branch: prRes.branch }
                });
                await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Published: pushed to ${prRes.branch}` });
              }
            } else {
              const prErrId = await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'stderr', name: 'github pr create failed', content: String(prRes.error) });
              await appendEventRow(db, {
                id: newId('evt'),
                ts: nowIso(),
                seq: seq++,
                type: 'tool.call.failed',
                source: 'worker',
                severity: 'warn',
                project_id: projectId,
                task_id: taskId ?? undefined,
                run_id: runId,
                step_id: stepIdForNode,
                payload: { tool: 'github.pr.create', error: prRes.error, stderr_artifact_id: prErrId }
              });
            }

            await stepSucceed(stepIdForNode, 'publish', { ok: true });
            return;
          }

          if (kind === 'summary') {
            await upsertStepRunning(stepIdForNode, 'summary', { pipeline_node_id: nodeId, wave: waveIndexByNode.get(nodeId) ?? 0 });
            const prRow = await db.select({ prUrl: runs.prUrl }).from(runs).where(eq(runs.id, runId)).limit(1);
            const summary = `Run completed (pipeline). ${prRow?.[0]?.prUrl ? 'PR: ' + String(prRow[0].prUrl) : ''}`.trim();
            await writeArtifact({ db, projectId, runId, stepId: stepIdForNode, kind: 'summary', name: 'summary', content: summary + '\n' });
            await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: summary });
            await stepSucceed(stepIdForNode, 'summary', { ok: true });
            return;
          }

          // Unknown node kind: succeed (no-op) to avoid deadlocks.
          await upsertStepRunning(stepIdForNode, kind, { pipeline_node_id: nodeId, wave: waveIndexByNode.get(nodeId) ?? 0, note: 'noop' });
          await stepSucceed(stepIdForNode, kind, { ok: true, noop: true });
        }

        // Scheduler
        const done = new Set<string>();
        const running = new Set<string>();
        const failedNodes = new Set<string>();

        // Seed done from DB (in case of retries)
        const stepRows = await db.select({ id: runSteps.id, name: runSteps.name, status: runSteps.status, inputJson: runSteps.inputJson }).from(runSteps).where(eq(runSteps.runId, runId));
        for (const r of stepRows) {
          const nodeId = String((r as any)?.inputJson?.pipeline_node_id ?? '');
          if (!nodeId) continue;
          const st = String((r as any).status ?? 'queued');
          if (st === 'succeeded') done.add(nodeId);
          if (st === 'failed') failedNodes.add(nodeId);
        }

        const maxWave = waves.length ? waves.length - 1 : 0;
        for (let wi = 0; wi <= maxWave; wi++) {
          if (failedNodes.size) break;
          const waveNodes = (waves[wi] ?? []).filter((nid) => nodeKindById.has(String(nid)));
          if (!waveNodes.length) continue;

          // only nodes with deps satisfied
          const runnable = waveNodes.filter((nid) => {
            const id = String(nid);
            if (done.has(id)) return false;
            if (failedNodes.has(id)) return false;
            const d = deps.get(id) ?? new Set();
            for (const dep of d) if (!done.has(dep)) return false;
            return true;
          });

          const writers = runnable.filter((nid) => writesWorkspace(nodeKindById.get(String(nid)) ?? String(nid)));
          const readers = runnable.filter((nid) => !writesWorkspace(nodeKindById.get(String(nid)) ?? String(nid)));

          // run non-writing nodes in parallel
          await Promise.all(
            readers.map(async (nid) => {
              const id = String(nid);
              running.add(id);
              try {
                await runNode(id);
                done.add(id);
              } catch {
                failedNodes.add(id);
              } finally {
                running.delete(id);
              }
            })
          );

          // run writing nodes one-by-one (hard safety rule)
          for (const nid of writers) {
            if (failedNodes.size) break;
            const id = String(nid);
            running.add(id);
            try {
              await runNode(id);
              done.add(id);
            } catch {
              failedNodes.add(id);
            } finally {
              running.delete(id);
            }
          }
        }

        if (failedNodes.size) {
          await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'run.failed',
            source: 'worker',
            severity: 'error',
            project_id: projectId,
            task_id: taskId ?? undefined,
            run_id: runId,
            payload: { message: 'Pipeline failed', failed_nodes: Array.from(failedNodes) }
          });
          return;
        }

        // Mark run completed if pipeline had a summary node or all nodes succeeded.
        await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(runs.id, runId));
        await appendEventRow(db, {
          id: newId('evt'),
          ts: nowIso(),
          seq: seq++,
          type: 'run.completed',
          source: 'worker',
          severity: 'info',
          project_id: projectId,
          task_id: taskId ?? undefined,
          run_id: runId,
          payload: { message: 'Run completed (pipeline DAG)' }
        });

        // Task lifecycle projection: after success
        if (kind === 'execute') {
          const pr = await db
            .select({ prUrl: runs.prUrl, prState: runs.prState })
            .from(runs)
            .where(eq(runs.id, runId))
            .limit(1);
          const prUrl = pr?.[0]?.prUrl ? String(pr[0].prUrl) : '';
          const prState = pr?.[0]?.prState ? String(pr[0].prState) : '';
          const next = prUrl ? 'review' : prState === 'pushed' ? 'done' : 'review';
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: next });
        }

        return;
      }

      // AUTO_APPLY_START
      // Auto-apply path (policy allowed, no approval required).
      await appendEventRow(db, {
        id: newId('evt'),
        ts: nowIso(),
        seq: seq++,
        type: 'run.step.progress',
        source: 'worker',
        severity: 'info',
        project_id: projectId,
        task_id: taskId ?? undefined,
        run_id: runId,
        step_id: stepId,
        payload: { message: 'Policy OK. Auto-applying patch + checks + commit + PR.' }
      });

      const patchFile = path.join(ws, `.ocdash_auto_${Date.now()}.diff`);
      await fs.writeFile(patchFile, normalizedPatchText, 'utf8');

      let applyRes = await runCmd({ cwd: ws, cmd: `git apply ${patchFile}` });
      let method = 'git apply';
      if (applyRes.exitCode !== 0) {
        const p2 = await runCmd({ cwd: ws, cmd: `patch -p1 --forward --batch -i ${patchFile}` });
        method = 'patch -p1';
        applyRes = {
          exitCode: p2.exitCode,
          stdout: `${applyRes.stdout}\n---\n[fallback patch stdout]\n${p2.stdout}`,
          stderr: `${applyRes.stderr}\n---\n[fallback patch stderr]\n${p2.stderr}`
        };
      }

      const applyOutId = await writeArtifact({
        db,
        projectId,
        runId,
        stepId,
        kind: 'stdout',
        name: `apply patch stdout (${method})`,
        content: String(applyRes.stdout ?? '')
      });
      const applyErrId = await writeArtifact({
        db,
        projectId,
        runId,
        stepId,
        kind: 'stderr',
        name: `apply patch stderr (${method})`,
        content: String(applyRes.stderr ?? '')
      });

      if (applyRes.exitCode !== 0) {
        await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
        await appendEventRow(db, {
          id: newId('evt'),
          ts: nowIso(),
          seq: seq++,
          type: 'run.step.failed',
          source: 'worker',
          severity: 'error',
          project_id: projectId,
          task_id: taskId ?? undefined,
          run_id: runId,
          step_id: stepId,
          payload: { message: 'Auto-apply patch failed', stdout_artifact_id: applyOutId, stderr_artifact_id: applyErrId }
        });
        return;
      }

      const autoCmdsRaw = String(process.env.OC_DASH_AUTO_COMMANDS ?? '').trim();
      const cmds = autoCmdsRaw
        ? autoCmdsRaw.split(',').map((x) => x.trim()).filter(Boolean)
        : ['npm test', 'npm run lint', 'npm run typecheck'];

      const hasPkg = await fileExists(path.join(ws, 'package.json'));
      if (!hasPkg) {
        await appendEventRow(db, {
          id: newId('evt'),
          ts: nowIso(),
          seq: seq++,
          type: 'run.step.progress',
          source: 'worker',
          severity: 'info',
          project_id: projectId,
          task_id: taskId ?? undefined,
          run_id: runId,
          step_id: stepId,
          payload: { message: 'No package.json; skipping checks.' }
        });
      } else {

        const limit = 2;
        let idx = 0;
        let failed: { cmd: string; outId: string; errId: string; exitCode: number } | null = null;

        const runOne = async () => {
          while (true) {
            const i = idx++;
            const cmd = cmds[i];
            if (!cmd) return;
            if (failed) return;

            const res = await runCmd({ cwd: ws, cmd });
            const outId = await writeArtifact({
              db,
              projectId,
              runId,
              stepId,
              kind: 'stdout',
              name: `${cmd} stdout`,
              content: String(res.stdout ?? '')
            });
            const errId = await writeArtifact({
              db,
              projectId,
              runId,
              stepId,
              kind: 'stderr',
              name: `${cmd} stderr`,
              content: String(res.stderr ?? '')
            });

            if (res.exitCode !== 0 && !failed) {
              failed = { cmd, outId, errId, exitCode: res.exitCode };
              return;
            }
          }
        };

        const workers = Array.from({ length: Math.max(1, Math.min(limit, cmds.length)) }, () => runOne());
        await Promise.all(workers);

        const f = failed as unknown as { cmd: string; outId: string; errId: string; exitCode: number } | null;
        if (f) {
          await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'run.step.failed',
            source: 'worker',
            severity: 'error',
            project_id: projectId,
            task_id: taskId ?? undefined,
            run_id: runId,
            step_id: stepId,
            payload: {
              message: `checks failed: ${f.cmd}`,
              cmd: f.cmd,
              exit_code: f.exitCode,
              stdout_artifact_id: f.outId,
              stderr_artifact_id: f.errId
            }
          });
          return;
        }
      }

      await runCmd({ cwd: ws, cmd: 'git add -A' });
      const commitMsg = `ocdash: auto-apply for ${taskId ?? runId}`;
      const commitRes = await runCmd({ cwd: ws, cmd: `git commit -m "${commitMsg.replace(/"/g, "'")}"` });
      const cOut = await writeArtifact({ db, projectId, runId, stepId, kind: 'stdout', name: 'git commit stdout', content: (commitRes.stdout ?? '') as string });
      const cErr = await writeArtifact({ db, projectId, runId, stepId, kind: 'stderr', name: 'git commit stderr', content: (commitRes.stderr ?? '') as string });

      if (commitRes.exitCode !== 0) {
        await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
        await appendEventRow(db, {
          id: newId('evt'),
          ts: nowIso(),
          seq: seq++,
          type: 'run.step.failed',
          source: 'worker',
          severity: 'error',
          project_id: projectId,
          task_id: taskId ?? undefined,
          run_id: runId,
          step_id: stepId,
          payload: { message: 'git commit failed', stdout_artifact_id: cOut, stderr_artifact_id: cErr }
        });
        return;
      }

      const prTitle = `ocdash: ${taskTitle || taskId || runId}`;
      const prBody = `Automated changes from OpenCode Dashboard.\n\nRun: ${runId}\nProject: ${projectId}\nTask: ${taskId ?? '(none)'}\n`;
      const prRes = await ensurePushedOrPr({ ws, runId, baseBranch, title: prTitle, body: prBody });

      if (prRes.ok) {
        if (prRes.mode === 'pr') {
          await db.update(runs)
            .set({ prUrl: prRes.url, prBranch: prRes.branch, prNumber: prRes.number ?? null, prRepo: prRes.repo ?? null, prState: prRes.state ?? null })
            .where(eq(runs.id, runId));

          const prArtId = await writeArtifact({
            db,
            projectId,
            runId,
            stepId,
            kind: 'github_pr',
            name: 'GitHub PR',
            content: prRes.url + '\n'
          });

          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'tool.call.completed',
            source: 'worker',
            severity: 'info',
            project_id: projectId,
            task_id: taskId ?? undefined,
            run_id: runId,
            step_id: stepId,
            payload: { tool: 'github.pr.create', url: prRes.url, branch: prRes.branch, number: prRes.number ?? null, repo: prRes.repo ?? null, state: prRes.state ?? null, artifact_id: prArtId }
          });

          await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Published: PR ${(prRes as any).url}` });
        } else {
          await db.update(runs)
            .set({ prUrl: null, prBranch: prRes.branch, prNumber: null, prRepo: null, prState: 'pushed' })
            .where(eq(runs.id, runId));

          await appendEventRow(db, {
            id: newId('evt'),
            ts: nowIso(),
            seq: seq++,
            type: 'tool.call.completed',
            source: 'worker',
            severity: 'info',
            project_id: projectId,
            task_id: taskId ?? undefined,
            run_id: runId,
            step_id: stepId,
            payload: { tool: 'github.push.initial', branch: prRes.branch }
          });


          await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Published: pushed to ${prRes.branch}` });
        }
      } else {
        const prErrId = await writeArtifact({ db, projectId, runId, stepId, kind: 'stderr', name: 'github pr create failed', content: String(prRes.error) });
        await appendEventRow(db, {
          id: newId('evt'),
          ts: nowIso(),
          seq: seq++,
          type: 'tool.call.failed',
          source: 'worker',
          severity: 'warn',
          project_id: projectId,
          task_id: taskId ?? undefined,
          run_id: runId,
          step_id: stepId,
          payload: { tool: 'github.pr.create', error: prRes.error, stderr_artifact_id: prErrId }
        });
      }

      await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(runs.id, runId));
      await appendEventRow(db, {
        id: newId('evt'),
        ts: nowIso(),
        seq: seq++,
        type: 'run.completed',
        source: 'worker',
        severity: 'info',
        project_id: projectId,
        task_id: taskId ?? undefined,
        run_id: runId,
        payload: { message: 'Run completed (auto-apply + checks + commit + PR)' }
      });

        // Task lifecycle projection: after success
        if (kind === 'execute') {
          const pr = await db
            .select({ prUrl: runs.prUrl, prState: runs.prState })
            .from(runs)
            .where(eq(runs.id, runId))
            .limit(1);
          const prUrl = pr?.[0]?.prUrl ? String(pr[0].prUrl) : '';
          const prState = pr?.[0]?.prState ? String(pr[0].prState) : '';
          const next = prUrl ? 'review' : prState === 'pushed' ? 'done' : 'review';
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: next });
        }

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run completed. ${runRow?.prUrl ? 'PR: ' + runRow.prUrl : ''}`.trim() });

      return;
      // AUTO_APPLY_END
    }
  }

  if (result.exitCode === 0) {
    await db.update(runSteps).set({ status: 'succeeded', finishedAt: new Date(), outputJson: { exitCode: result.exitCode } }).where(eq(runSteps.id, stepId));
    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'run.step.completed',
      source: 'worker',
      severity: 'info',
      project_id: projectId,
      task_id: taskId ?? undefined,
      thread_id: threadId ?? undefined,
      run_id: runId,
      step_id: stepId,
      payload: { name: stepName }
    });
    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'run.completed',
      source: 'worker',
      severity: 'info',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      payload: { message: 'Run completed (opencode)' }
    });

        // Task lifecycle projection: after success
        if (kind === 'execute') {
          const pr = await db
            .select({ prUrl: runs.prUrl, prState: runs.prState })
            .from(runs)
            .where(eq(runs.id, runId))
            .limit(1);
          const prUrl = pr?.[0]?.prUrl ? String(pr[0].prUrl) : '';
          const prState = pr?.[0]?.prState ? String(pr[0].prState) : '';
          const next = prUrl ? 'review' : prState === 'pushed' ? 'done' : 'review';
          await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: next });
        }

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run completed. ${runRow?.prUrl ? 'PR: ' + runRow.prUrl : ''}`.trim() });

    await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(runs.id, runId));
  } else {
    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'run.failed',
      source: 'worker',
      severity: 'error',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      payload: { message: 'Run failed (opencode)' }
    });

        await maybeUpdateTaskStatus({ db, projectId, taskId, runId, nextStatus: 'blocked' });

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Run failed. Check timeline/artifacts for details.' });

    await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
  }
  } finally {
    hbStop = true;
    clearInterval(hbTimer);
  }

}

async function main() {
  const mode = String(process.env.OC_DASH_MODE ?? "worker").trim();
  if (mode === "scheduler") {
    await schedulerMain();
    return;
  }

  const { db } = makeDb(DATABASE_URL);

    let backoffMs = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let queued: { id: string }[] = [];
    try {
      queued = await db
        .select({ id: runs.id })
        .from(runs)
        .where(sql`status in ('claimed', 'queued')`)
        .orderBy(sql`case when status='claimed' then 0 else 1 end`, runs.createdAt)
        .limit(1);
      backoffMs = 0;
    } catch (err) {
      backoffMs = backoffMs ? Math.min(backoffMs * 2, 10_000) : 250;
      console.error('[worker] DB poll failed; backing off', backoffMs, err);
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    if (queued.length) {
      const runId = queued[0]!.id;
      try {
        const claimed = await db
          .update(runs)
          .set({ status: 'running', startedAt: new Date(), workerId: WORKER_ID, heartbeatAt: new Date() } as any)
          .where(and(eq(runs.id, runId), sql`status in ('claimed', 'queued')`))
          .returning({ id: runs.id });
        if (!claimed.length) continue;

        await processRun(db, runId);
      } catch (err) {
        console.error('Run failed', runId, err);
        await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
      }
    } else {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
