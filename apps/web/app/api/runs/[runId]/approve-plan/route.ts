import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { artifacts, runs } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import { appendProjectEvent } from '../../../_lib/eventlog';

export const runtime = 'nodejs';

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const rid = (runId ?? '').trim();
  if (!rid) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const rrows = await db.select().from(runs).where(eq(runs.id, rid)).limit(1);
    if (!rrows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const r = rrows[0]!;
    if (r.kind !== 'plan') {
      return NextResponse.json({ error: 'not a plan run' }, { status: 400 });
    }
    if (r.status !== 'needs_approval') {
      return NextResponse.json({ error: `run is not in needs_approval (status=${r.status})` }, { status: 400 });
    }

    // Ensure plan artifact exists.
    const planRows = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, rid), eq(artifacts.kind, 'plan')))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);

    if (!planRows.length) return NextResponse.json({ error: 'missing plan artifact' }, { status: 400 });

    const planArtifact = planRows[0]!;
    const execId = newId('run');

    await db.insert(runs).values({
      id: execId,
      projectId: r.projectId,
      taskId: r.taskId,
      parentRunId: rid,
      modelProfile: r.modelProfile,
      kind: 'execute',
      status: 'queued'
    });

    // Copy plan artifact onto the execute run so the worker can use it as context.
    const copiedPlanId = newId('art');
    const copiedStepId = 'stp_plan_approval';

    await db.insert(artifacts).values({
      id: copiedPlanId,
      projectId: r.projectId,
      runId: execId,
      stepId: copiedStepId,
      kind: 'plan',
      name: 'approved plan',
      contentText: String(planArtifact.contentText ?? '')
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: execId,
      type: 'artifact.created',
      payload: { artifact: { id: copiedPlanId, kind: 'plan', name: 'approved plan' }, from_plan_run_id: rid }
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: execId,
      type: 'run.created',
      payload: {
        run: { id: execId, project_id: r.projectId, task_id: r.taskId, kind: 'execute', parent_run_id: rid },
        from_plan_run: rid
      }
    });

    await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(runs.id, rid));

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: rid,
      type: 'approval.resolved',
      severity: 'info',
      payload: { approved: true, plan_run_id: rid, execute_run_id: execId }
    });

    return NextResponse.json({ ok: true, execute_run_id: execId }, { status: 200 });
  } finally {
    await pool.end();
  }
}
