import './env.js';

import { and, desc, eq, sql } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { makeDb } from '@ocdash/db/client';
import { artifacts, events, messages, projects, runs, tasks, threads } from '@ocdash/db/schema';

import { newId } from '@ocdash/shared';
import type { OcdashEvent } from '@ocdash/shared';
import { extractUnifiedDiffFromText, wrapHunkAsFilePatch } from '@ocdash/shared/patch';
import { policyCheckCommand, policyCheckPath } from '@ocdash/shared/policy';
import { prepareWorkspaceForProject } from '@ocdash/shared/workspaces';
import { validatePlanJson } from '@ocdash/shared/plan';
import { ensurePushedOrPr } from '@ocdash/shared/github';

import { requireEnv } from './env.js';
import { opencodeRun } from './opencode.js';
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
  projectId: string;
  runId: string;
  stepId: string;
  kind: string;
  name: string;
  content: string;
}): Promise<string> {
  const id = newId('art');
  await db.insert(artifacts).values({
    id,
    projectId,
    runId,
    stepId,
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
  projectId: string;
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

async function processRun(db: any, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const runRow = runRows[0];
  const projectId = runRow?.projectId as string | undefined;
  const taskId = (runRow?.taskId as string | null | undefined) ?? null;
  const threadId = ((runRow as any)?.threadId as string | null | undefined) ?? null;
  const kind = (runRow as any)?.kind ?? 'execute';

  if (!projectId) throw new Error(`Run ${runId} missing projectId`);

  if (runRow?.status === 'cancelled') return;

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

  await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run started (${kind}).` });

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

  const stepId = 'stp_opencode_run';

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

const baseTask = taskId ? `Task: ${taskTitle}\n\nDetails:\n${taskBody}` : `Project ${projectId}`;

  const msg =
    kind === 'plan'
      ? `${baseTask}\n\nYou are planning work. Output a plan as JSON inside a fenced \`\`\`json block with:\n{\n  \"summary\": string,\n  \"steps\": [{\"title\": string, \"details\": string, \"risk\": \"low\"|\"med\"|\"high\"}],\n  \"files\": string[],\n  \"commands\": string[]\n}\n\nDo NOT output a diff. Do NOT execute anything.\n`
      : `${baseTask}\n\n${approvedPlanJson ? `Approved plan (JSON):\n\n\`\`\`json\n${approvedPlanJson}\n\`\`\`\n\nFollow the approved plan.\n\n` : ''}Return a unified diff in a fenced \`\`\`diff block if code changes are needed. Include full diff headers (diff --git, ---/+++).\n\nDo the next best action.`;

  const model = (process.env.OPENCODE_MODEL ?? '').trim() || undefined;
  const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS ?? '600000');

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
    projectId,
    runId,
    stepId,
    kind: 'stdout',
    name: 'opencode stdout',
    content: result.stdout ?? ''
  });

  const stderrId = await writeArtifact({
    db,
    projectId,
    runId,
    stepId,
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

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Approval required. Approve or reject in the dashboard to continue.' });

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
        content: applyRes.stdout
      });
      const applyErrId = await writeArtifact({
        db,
        projectId,
        runId,
        stepId,
        kind: 'stderr',
        name: `apply patch stderr (${method})`,
        content: applyRes.stderr
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
        for (const cmd of cmds) {
          const res = await runCmd({ cwd: ws, cmd });
          const outId = await writeArtifact({ db, projectId, runId, stepId, kind: 'stdout', name: `${cmd} stdout`, content: res.stdout });
          const errId = await writeArtifact({ db, projectId, runId, stepId, kind: 'stderr', name: `${cmd} stderr`, content: res.stderr });
          if (res.exitCode !== 0) {
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
              payload: { message: `${cmd} failed`, stdout_artifact_id: outId, stderr_artifact_id: errId }
            });
            return;
          }
        }
      }

      await runCmd({ cwd: ws, cmd: 'git add -A' });
      const commitMsg = `ocdash: auto-apply for ${taskId ?? runId}`;
      const commitRes = await runCmd({ cwd: ws, cmd: `git commit -m "${commitMsg.replace(/"/g, "'")}"` });
      const cOut = await writeArtifact({ db, projectId, runId, stepId, kind: 'stdout', name: 'git commit stdout', content: commitRes.stdout });
      const cErr = await writeArtifact({ db, projectId, runId, stepId, kind: 'stderr', name: 'git commit stderr', content: commitRes.stderr });

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

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: `Run completed. ${runRow?.prUrl ? 'PR: ' + runRow.prUrl : ''}`.trim() });

      return;
      // AUTO_APPLY_END
      }
    }
  }

  if (result.exitCode === 0) {
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

        await appendThreadMessage({ db, projectId, taskId, threadId, role: 'assistant', content: 'Run failed. Check timeline/artifacts for details.' });

    await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
  }
}

async function main() {
  const { db } = makeDb(DATABASE_URL);

    let backoffMs = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let queued: { id: string }[] = [];
    try {
      queued = await db.select({ id: runs.id }).from(runs).where(eq(runs.status, 'queued')).limit(1);
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
          .set({ status: 'running', startedAt: new Date(), workerId: WORKER_ID })
          .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
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
