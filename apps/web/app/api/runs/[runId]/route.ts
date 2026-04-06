import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { pipelines, runs } from '@ocdash/db/schema';

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
    const rows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const run = rows[0] as any;
    let pipeline: any = null;
    if (run?.pipelineId) {
      const prows = await db.select().from(pipelines).where(eq(pipelines.id, run.pipelineId)).limit(1);
      if (prows.length) pipeline = prows[0];
    }

    return NextResponse.json({ run, pipeline });
  } finally {
    await pool.end();
  }
}
