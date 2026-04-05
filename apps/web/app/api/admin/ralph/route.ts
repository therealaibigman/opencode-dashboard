import { NextResponse } from 'next/server';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { artifacts, runs, tasks } from '@ocdash/db/schema';

export const runtime = 'nodejs';

// Admin helper endpoint: summarize ralph loop runs for a project.
// Returns tasks + latest execute/review/publish runs per loop_index.
export async function GET(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const projectId = sp.get('project_id')?.trim() || '';
  const limitTasks = Math.min(Math.max(Number(sp.get('limit_tasks') ?? 50) || 50, 1), 200);

  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    // Prefer active tasks; include blocked/review/in_progress first.
    const trows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        updatedAt: tasks.updatedAt
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt)))
      .orderBy(
        // rough priority: blocked/review/in_progress first
        desc(sql`(${tasks.status} IN ('blocked','review','in_progress'))::int`),
        desc(tasks.updatedAt)
      )
      .limit(limitTasks);

    const taskIds = trows.map((t) => t.id);
    if (!taskIds.length) return NextResponse.json({ tasks: [] });

    const rrows = await db
      .select({
        id: runs.id,
        taskId: runs.taskId,
        kind: runs.kind,
        status: runs.status,
        loopIndex: (runs as any).loopIndex,
        parentRunId: runs.parentRunId,
        createdAt: runs.createdAt,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        prUrl: runs.prUrl,
        prBranch: runs.prBranch
      })
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          inArray(runs.taskId, taskIds as any),
          inArray(runs.kind, ['execute', 'review', 'publish'] as any)
        )
      )
      .orderBy(desc(runs.createdAt))
      .limit(1000);

    // Fetch latest review verdict artifacts for visibility.
    const verdictRows = await db
      .select({ runId: artifacts.runId, contentText: artifacts.contentText, createdAt: artifacts.createdAt })
      .from(artifacts)
      .where(and(eq(artifacts.projectId, projectId), inArray(artifacts.runId, rrows.filter((r) => r.kind === 'review').map((r) => r.id) as any), eq(artifacts.kind, 'review_verdict')))
      .orderBy(desc(artifacts.createdAt))
      .limit(500);

    const verdictByReviewRun = new Map<string, { contentText: string; createdAt: string }>();
    for (const v of verdictRows) {
      const rid = String(v.runId ?? '');
      if (!rid) continue;
      if (verdictByReviewRun.has(rid)) continue;
      verdictByReviewRun.set(rid, { contentText: String(v.contentText ?? ''), createdAt: new Date(v.createdAt as any).toISOString() });
    }

    const byTask: any[] = [];
    for (const t of trows) {
      const runsForTask = rrows.filter((r) => r.taskId === t.id);
      // group by loopIndex
      const loops = new Map<number, any>();
      for (const r of runsForTask) {
        const li = Number((r as any).loopIndex ?? 0);
        const obj = loops.get(li) ?? { loop_index: li, execute: null, review: null, publish: null, review_verdict: null };
        const entry = {
          id: r.id,
          status: r.status,
          created_at: new Date(r.createdAt as any).toISOString(),
          finished_at: r.finishedAt ? new Date(r.finishedAt as any).toISOString() : null,
          pr_url: r.prUrl ?? null,
          pr_branch: r.prBranch ?? null
        };
        if (r.kind === 'execute') obj.execute = obj.execute ?? entry;
        if (r.kind === 'review') {
          obj.review = obj.review ?? entry;
          const v = verdictByReviewRun.get(r.id);
          if (v) obj.review_verdict = v;
        }
        if (r.kind === 'publish') obj.publish = obj.publish ?? entry;
        loops.set(li, obj);
      }

      const loopList = Array.from(loops.values()).sort((a, b) => a.loop_index - b.loop_index).slice(-5);
      byTask.push({ task: t, loops: loopList });
    }

    return NextResponse.json({ tasks: byTask });
  } finally {
    await pool.end();
  }
}
