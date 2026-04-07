import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { pipelines, runSteps, runs } from '@ocdash/db/schema';
import { appendProjectEvent } from '@/app/api/_lib/eventlog';

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

    // If this run is a pipeline run, reset downstream steps too.
    // We derive downstream via pipeline graph edges using pipeline_node_id stored on step.inputJson.
    const pipelineId = (run as any)?.pipelineId as string | null | undefined;
    const nodeId = String((stRows[0] as any)?.inputJson?.pipeline_node_id ?? '').trim();

    let downstreamStepIds: string[] = [];
    if (pipelineId && nodeId) {
      try {
        const prows = await db.select().from(pipelines).where(eq(pipelines.id, pipelineId)).limit(1);
        const graph = (prows?.[0] as any)?.graphJson ?? (prows?.[0] as any)?.graph_json ?? {};
        const edges: Array<[string, string]> = Array.isArray((graph as any)?.edges) ? (graph as any).edges : [];

        const out = new Map<string, Set<string>>();
        for (const [a, b] of edges) {
          const A = String(a);
          const B = String(b);
          if (!out.has(A)) out.set(A, new Set());
          out.get(A)!.add(B);
        }

        // BFS to compute downstream node ids.
        const seen = new Set<string>();
        const q: string[] = [nodeId];
        seen.add(nodeId);
        while (q.length) {
          const cur = q.shift()!;
          for (const nxt of out.get(cur) ?? []) {
            if (seen.has(nxt)) continue;
            seen.add(nxt);
            q.push(nxt);
          }
        }
        seen.delete(nodeId);

        if (seen.size) {
          const stepRows = await db
            .select({ id: runSteps.id, inputJson: runSteps.inputJson })
            .from(runSteps)
            .where(eq(runSteps.runId, rid));

          downstreamStepIds = stepRows
            .filter((r: any) => seen.has(String(r?.inputJson?.pipeline_node_id ?? '')))
            .map((r: any) => String(r.id));
        }
      } catch {
        downstreamStepIds = [];
      }
    }

    const resetIds = [sid, ...downstreamStepIds];
    for (const id of resetIds) {
      await db
        .update(runSteps)
        .set({
          status: 'queued',
          startedAt: null,
          finishedAt: null,
          outputJson: {}
        } as any)
        .where(eq(runSteps.id, id));
    }

    // Timeline/audit event (UI can use this to show a toast).
    try {
      await appendProjectEvent({
        databaseUrl: url,
        projectId: run.projectId,
        taskId: run.taskId ?? null,
        runId: rid,
        type: 'run.step.retried',
        payload: {
          step_id: sid,
          reset_step_ids: resetIds,
          reset_count: resetIds.length
        }
      });
    } catch {
      // Best-effort: retry should still succeed even if event log append fails.
    }

    return NextResponse.json({ ok: true, run_id: rid, step_id: sid, reset_step_ids: resetIds }, { status: 200 });
  } finally {
    await pool.end();
  }
}
