import './env.js';

import { and, eq, sql } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { events, runs, tasks } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import type { OcdashEvent } from '@ocdash/shared';
import { requireEnv } from './env.js';
import { ensureProjectWorkspace } from './workspaces.js';
import { opencodeRun } from './opencode.js';

const DATABASE_URL = requireEnv('DATABASE_URL');
const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '750');

const WORKSPACES_ROOT = process.env.PROJECT_WORKSPACES_ROOT ?? '/home/exedev/.openclaw/workspace/opencode-workspaces';

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

function clip(s: string, max = 6000) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}\n…(truncated)…` : s;
}

async function processRun(db: any, runId: string) {
  // Load run metadata
  const runRows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const runRow = runRows[0];
  const projectId = runRow?.projectId as string | undefined;
  const taskId = (runRow?.taskId as string | null | undefined) ?? null;

  if (!projectId) throw new Error(`Run ${runId} missing projectId`);

  // Load task (optional) to drive prompt
  let taskTitle = '';
  let taskBody = '';
  if (taskId) {
    const trows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (trows.length) {
      taskTitle = trows[0]!.title;
      taskBody = trows[0]!.bodyMd;
    }
  }

  await db
    .update(runs)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, 'queued')));

  let seq = await getNextSeq(db, runId);

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
    payload: { message: 'Run started' }
  });

  // Step: opencode run (MVP)
  const stepId = 'stp_opencode_run';

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
    payload: { step: { name: 'opencode.run', kind: 'tool' }, message: 'Running OpenCode' }
  });

  const ws = await ensureProjectWorkspace({ root: WORKSPACES_ROOT, projectId });
  const msg = taskId
    ? `Task: ${taskTitle}\n\nDetails:\n${taskBody}\n\nDo the next best action. If code changes are needed, explain what you would change.`
    : `Project ${projectId}: Do the next best action.`;

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
    payload: { tool: 'opencode.run', args: { cwd: ws, message: taskId ? taskTitle : '(no task)' } }
  });

  const result = await opencodeRun({ cwd: ws, message: msg });

  if (result.exitCode === 0) {
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
      payload: {
        tool: 'opencode.run',
        result: { exit_code: result.exitCode, stdout: clip(result.stdout), stderr: clip(result.stderr) }
      }
    });

    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'run.step.completed',
      source: 'worker',
      severity: 'info',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      step_id: stepId,
      payload: { step: { name: 'opencode.run' }, message: 'OpenCode run finished' }
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

    await db
      .update(runs)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(runs.id, runId));
  } else {
    await appendEventRow(db, {
      id: newId('evt'),
      ts: nowIso(),
      seq: seq++,
      type: 'tool.call.failed',
      source: 'worker',
      severity: 'error',
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId,
      step_id: stepId,
      payload: {
        tool: 'opencode.run',
        result: { exit_code: result.exitCode, stdout: clip(result.stdout), stderr: clip(result.stderr) }
      }
    });

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
      payload: { step: { name: 'opencode.run' }, message: 'OpenCode run failed' }
    });

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

    await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, runId));
  }
}

async function main() {
  const { db } = makeDb(DATABASE_URL);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const queued = await db
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.status, 'queued'))
      .limit(1);

    if (queued.length) {
      const runId = queued[0]!.id;
      try {
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
