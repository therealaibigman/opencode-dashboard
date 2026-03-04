import { makeDb } from '@ocdash/db/client';
import { events as eventsTable } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import type { EventSource, EventSeverity, EventType, OcdashEvent } from '@ocdash/shared';

export function asEventRow(row: typeof eventsTable.$inferSelect): OcdashEvent {
  return {
    id: row.id,
    ts: row.ts instanceof Date ? row.ts.toISOString() : new Date(row.ts as any).toISOString(),
    seq: Number(row.seq ?? 0),
    type: row.type as EventType,
    source: row.source as EventSource,
    severity: row.severity as EventSeverity,
    project_id: row.projectId ?? undefined,
    task_id: row.taskId ?? undefined,
    run_id: row.runId ?? undefined,
    step_id: row.stepId ?? undefined,
    thread_id: row.threadId ?? undefined,
    correlation_id: row.correlationId ?? undefined,
    payload: (row.payload ?? {}) as any
  };
}

export async function appendProjectEvent({
  databaseUrl,
  projectId,
  type,
  source = 'api',
  severity = 'info',
  taskId,
  runId,
  payload
}: {
  databaseUrl: string;
  projectId: string;
  type: EventType;
  source?: EventSource;
  severity?: EventSeverity;
  taskId?: string | null;
  runId?: string | null;
  payload: unknown;
}) {
  const { db, pool } = makeDb(databaseUrl);
  try {
    const ev: OcdashEvent = {
      id: newId('evt'),
      ts: new Date().toISOString(),
      seq: 0,
      type,
      source,
      severity,
      project_id: projectId,
      task_id: taskId ?? undefined,
      run_id: runId ?? undefined,
      payload
    };

    await db.insert(eventsTable).values({
      id: ev.id,
      ts: new Date(ev.ts),
      projectId: projectId,
      taskId: taskId ?? null,
      runId: runId ?? null,
      seq: 0,
      type: ev.type,
      source: ev.source,
      severity: ev.severity,
      correlationId: null,
      payload: ev.payload ?? {}
    });

    return ev;
  } finally {
    await pool.end();
  }
}
