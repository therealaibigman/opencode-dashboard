import { NextResponse } from 'next/server';
import { and, desc, eq, sql } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runs } from '@ocdash/db/schema';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const projectId = sp.get('project_id')?.trim() || '';
  const onlyRetried = sp.get('only_retried') === '1' || sp.get('only_retried') === 'true';
  const activeOnly = sp.get('active_only') === '1' || sp.get('active_only') === 'true';
  const limit = Math.min(Math.max(Number(sp.get('limit') ?? 200) || 200, 1), 500);

  const { db, pool } = makeDb(url);
  try {
    const conds: any[] = [];
    if (projectId) conds.push(eq(runs.projectId, projectId));
    if (onlyRetried) conds.push(sql`${(runs as any).attemptCount} > 0`);
    if (activeOnly) conds.push(sql`${runs.status} IN ('queued','claimed','running','retry_wait','cancelling')`);

    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        kind: runs.kind,
        status: runs.status,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        claimedBy: (runs as any).claimedBy,
        claimedAt: (runs as any).claimedAt,
        heartbeatAt: (runs as any).heartbeatAt,
        attemptCount: (runs as any).attemptCount,
        nextEligibleAt: (runs as any).nextEligibleAt
      })
      .from(runs)
      .where(where as any)
      .orderBy(desc((runs as any).attemptCount), desc(runs.createdAt))
      .limit(limit);

    return NextResponse.json({ runs: rows });
  } finally {
    await pool.end();
  }
}
