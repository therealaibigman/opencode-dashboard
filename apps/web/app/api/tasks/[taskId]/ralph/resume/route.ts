import { NextResponse } from 'next/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runs, tasks, threads } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import { appendProjectEvent } from '../../../../_lib/eventlog';

export const runtime = 'nodejs';

// Resume a ralph loop after max loops reached (or any blocked task), by enqueueing a new execute run.
export async function POST(req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const { taskId } = await ctx.params;
  const tid = String(taskId ?? '').trim();
  if (!tid) return NextResponse.json({ error: 'taskId missing' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { reason?: string };
  const reason = String(body.reason ?? 'Resume ralph loop').trim() || 'Resume ralph loop';

  const { db, pool } = makeDb(url);
  try {
    const trows = await db.select().from(tasks).where(and(eq(tasks.id, tid), isNull(tasks.archivedAt))).limit(1);
    const t = trows[0] as any;
    if (!t) return NextResponse.json({ error: 'task not found' }, { status: 404 });

    const projectId = String(t.projectId);

    // Find latest loop index for this task.
    const mx = await db.execute(sql`
      SELECT COALESCE(max(loop_index), 0)::int AS n
      FROM runs
      WHERE project_id = ${projectId}
        AND task_id = ${tid}
    `);
    const maxLoop = Number((mx as any)?.rows?.[0]?.n ?? (mx as any)?.[0]?.n ?? 0);

    // Try to reuse latest thread id, otherwise create one.
    let threadId = '';
    const lastRun = await db
      .select({ threadId: runs.threadId })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.taskId, tid)))
      .orderBy(desc(runs.createdAt))
      .limit(1);
    threadId = String((lastRun[0] as any)?.threadId ?? '').trim();

    if (!threadId) {
      threadId = newId('thr');
      await db.insert(threads).values({
        id: threadId,
        projectId,
        taskId: tid,
        title: `Task ${tid}`,
        updatedAt: new Date()
      });

      await appendProjectEvent({
        databaseUrl: url,
        projectId,
        taskId: tid,
        threadId,
        type: 'thread.created',
        payload: { thread: { id: threadId, project_id: projectId, task_id: tid, title: `Task ${tid}` } }
      });
    }

    // Mark task back to in_progress.
    await db.update(tasks).set({ status: 'in_progress', updatedAt: new Date() } as any).where(eq(tasks.id, tid));

    const runId = newId('run');
    await db.insert(runs).values({
      id: runId,
      projectId,
      taskId: tid,
      threadId,
      kind: 'execute' as any,
      status: 'queued' as any,
      modelProfile: 'balanced',
      loopIndex: maxLoop + 1
    } as any);

    await appendProjectEvent({
      databaseUrl: url,
      projectId,
      taskId: tid,
      threadId,
      runId,
      type: 'ralph.resume',
      payload: { reason, run: { id: runId, kind: 'execute', loop_index: maxLoop + 1 } }
    });

    return NextResponse.json({ ok: true, run_id: runId });
  } finally {
    await pool.end();
  }
}
