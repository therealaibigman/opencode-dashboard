import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';

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
  const reason = (body.reason ?? '').trim() || 'Rejected by user';

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(runs).where(eq(runs.id, rid)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const r = rows[0]!;
    if (r.status !== 'needs_approval') {
      return NextResponse.json({ error: `run is not in needs_approval (status=${r.status})` }, { status: 400 });
    }

    await db
      .update(runs)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(and(eq(runs.id, rid), inArray(runs.status, ['needs_approval'])));

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: r.id,
      type: 'approval.resolved',
      severity: 'warn',
      payload: { auto: false, approved: false, reason }
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: r.id,
      type: 'run.failed',
      severity: 'warn',
      payload: { message: `Run rejected: ${reason}` }
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } finally {
    await pool.end();
  }
}
