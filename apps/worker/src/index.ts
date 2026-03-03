import './env.js';

import { and, eq, sql } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { events, runs } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import type { OcdashEvent } from '@ocdash/shared';
import { requireEnv } from './env.js';

const DATABASE_URL = requireEnv('DATABASE_URL');
const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? '750');

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

async function processRun(db: any, runId: string) {
  // Load run metadata for project-level feeds
  const runRows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  const runRow = runRows[0];
  const projectId = runRow?.projectId as string | undefined;
  const taskId = (runRow?.taskId as string | null | undefined) ?? null;

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

  const steps = ['plan', 'implement', 'test', 'review'] as const;
  for (const step of steps) {
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
      step_id: `stp_${step}`,
      payload: { step: { name: step, kind: 'llm' }, message: `Starting ${step}` }
    });

    for (let p = 0; p <= 100; p += 20) {
      await new Promise((r) => setTimeout(r, 250));
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
        step_id: `stp_${step}`,
        payload: { step: { name: step }, percent: p, message: `${step}: ${p}%` }
      });
    }

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
      step_id: `stp_${step}`,
      payload: { step: { name: step }, message: `${step} done` }
    });
  }

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
    payload: { message: 'Run completed (demo pipeline)' }
  });

  await db
    .update(runs)
    .set({ status: 'succeeded', finishedAt: new Date() })
    .where(eq(runs.id, runId));
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
