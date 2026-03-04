import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runSteps } from '@ocdash/db/schema';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const rid = (runId ?? '').trim();
  if (!rid) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(runSteps).where(eq(runSteps.runId, rid)).orderBy(asc(runSteps.createdAt)).limit(200);
    return NextResponse.json({ steps: rows });
  } finally {
    await pool.end();
  }
}
