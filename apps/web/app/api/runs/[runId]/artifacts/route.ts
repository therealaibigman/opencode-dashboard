import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { artifacts } from '@ocdash/db/schema';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(desc(artifacts.createdAt))
      .limit(200);

    return NextResponse.json({
      runId,
      artifacts: rows.map((a) => ({
        id: a.id,
        project_id: a.projectId,
        run_id: a.runId,
        step_id: a.stepId,
        kind: a.kind,
        name: a.name,
        created_at: a.createdAt
      }))
    });
  } finally {
    await pool.end();
  }
}
