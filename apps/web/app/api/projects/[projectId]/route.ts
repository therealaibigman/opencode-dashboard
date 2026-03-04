import { NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { events, projects, runs } from '@ocdash/db/schema';

export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const pid = (projectId ?? '').trim();
  if (!pid) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    // events table has no FK; delete it explicitly to avoid orphan logs.
    const runRows = await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, pid));
    const runIds = runRows.map((r) => r.id);

    if (runIds.length) {
      await db.delete(events).where(inArray(events.runId, runIds));
    }
    await db.delete(events).where(eq(events.projectId, pid));

    // projects cascades to tasks/runs/artifacts via FK constraints.
    const deleted = await db.delete(projects).where(eq(projects.id, pid));

    return NextResponse.json({ ok: true, project_id: pid, deleted }, { status: 200 });
  } finally {
    await pool.end();
  }
}
