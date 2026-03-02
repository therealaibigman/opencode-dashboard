import { NextResponse } from 'next/server';
import { desc, eq, and, gt } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { events } from '@ocdash/db/schema';

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
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.seq, 0)))
      .orderBy(desc(events.seq))
      .limit(200);

    return NextResponse.json({ runId, events: rows.reverse() });
  } finally {
    await pool.end();
  }
}
