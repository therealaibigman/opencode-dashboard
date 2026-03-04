import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

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

    // Ensure plan artifact exists (optional sanity)
    const planRows = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(eq(artifacts.runId, rid), eq(artifacts.kind, 'plan')))
      .limit(1);
    if (!planRows.length) return NextResponse.json({ error: 'missing plan artifact' }, { status: 400 });

    const execId = newId('run');

    await db.insert(runs).values({
      id: execId,
      projectId: r.projectId,
      taskId: r.taskId,
      modelProfile: r.modelProfile,
      kind: 'execute',
      status: 'queued'
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: execId,
      type: 'run.created',
      payload: { run: { id: execId, project_id: r.projectId, task_id: r.taskId, kind: 'execute' }, from_plan_run: rid }
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
