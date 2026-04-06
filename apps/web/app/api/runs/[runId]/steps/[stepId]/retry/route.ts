import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runSteps, runs } from '@ocdash/db/schema';

export const runtime = 'nodejs';

// Retry a single step.
// Semantics:
// - Allowed only when the parent run is active-ish (queued/claimed/running) OR failed.
// - Step is set back to queued with cleared timestamps/output.
// - Worker execution loop will pick it up on next wave.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; stepId: string }> }
) {
  const { runId, stepId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const rid = (runId ?? '').trim();
  const sid = (stepId ?? '').trim();
  if (!rid) return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  if (!sid) return NextResponse.json({ error: 'stepId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const runRows = await db.select().from(runs).where(eq(runs.id, rid)).limit(1);
    if (!runRows.length) return NextResponse.json({ error: 'run not found' }, { status: 404 });

    const run = runRows[0] as any;
    const status = String(run?.status ?? '');
    const finishedAt = run?.finishedAt ?? null;
    const isTerminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
    if (isTerminal || finishedAt) {
      return NextResponse.json({ error: `cannot retry step on terminal run status=${status}` }, { status: 409 });
    }

    const stRows = await db
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.id, sid), eq(runSteps.runId, rid)))
      .limit(1);
    if (!stRows.length) return NextResponse.json({ error: 'step not found' }, { status: 404 });

    await db
      .update(runSteps)
      .set({
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        outputJson: {}
      } as any)
      .where(eq(runSteps.id, sid));

    return NextResponse.json({ ok: true, run_id: rid, step_id: sid }, { status: 200 });
  } finally {
    await pool.end();
  }
}
