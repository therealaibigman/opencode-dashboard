import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { runs } from '@ocdash/db/schema';
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
    const rows = await db.select().from(runs).where(eq(runs.id, rid)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const r = rows[0]!;
    if (r.status === 'cancelled') {
      return NextResponse.json({ ok: true, run: r }, { status: 200 });
    }

    // Only allow cancel when it makes sense.
    if (!['queued', 'running', 'needs_approval'].includes(String(r.status))) {
      return NextResponse.json({ error: `cannot cancel from status ${r.status}` }, { status: 400 });
    }

    await db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runs.id, rid), inArray(runs.status, ['queued', 'running', 'needs_approval'])));

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: r.id,
      type: 'run.cancelled',
      severity: 'warn',
      payload: { message: 'Run cancelled (user)' }
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } finally {
    await pool.end();
  }
}
