import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runs } from '@ocdash/db/schema';
import { appendProjectEvent } from '../../../_lib/eventlog';

export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const rid = (runId ?? '').trim();
  if (!rid) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = (body.reason ?? '').trim() || 'Rejected plan';

  const { db, pool } = makeDb(url);
  try {
    const rrows = await db.select().from(runs).where(eq(runs.id, rid)).limit(1);
    if (!rrows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const r = rrows[0]!;
    if (r.kind !== 'plan') return NextResponse.json({ error: 'not a plan run' }, { status: 400 });

    await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, rid));

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: rid,
      type: 'approval.resolved',
      severity: 'warn',
      payload: { approved: false, reason }
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: rid,
      type: 'run.failed',
      severity: 'warn',
      payload: { message: `Plan rejected: ${reason}` }
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } finally {
    await pool.end();
  }
}
