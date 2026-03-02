import { and, eq, gt, or, asc } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { events } from '@ocdash/db/schema';
import type { OcdashEvent } from '@ocdash/shared';
import { toSse } from '@ocdash/shared';

export const runtime = 'nodejs';

function asEventRow(row: any): OcdashEvent {
  return {
    id: row.id,
    ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    seq: row.seq,
    type: row.type,
    source: row.source,
    severity: row.severity,
    project_id: row.projectId ?? undefined,
    task_id: row.taskId ?? undefined,
    thread_id: row.threadId ?? undefined,
    run_id: row.runId ?? undefined,
    step_id: row.stepId ?? undefined,
    correlation_id: row.correlationId ?? undefined,
    payload: row.payload ?? {}
  } as OcdashEvent;
}

export async function GET(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return new Response('DATABASE_URL missing', { status: 500 });

  const afterTs = new URL(req.url).searchParams.get('after_ts');
  const { db, pool } = makeDb(url);

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s));
      write(`: stream started for project ${projectId}\n\n`);

      // cursor by timestamp only (MVP). Good enough for low volume.
      let cursor = afterTs ? new Date(afterTs) : new Date(0);

      while (!closed) {
        const rows = await db
          .select()
          .from(events)
          .where(and(eq(events.projectId, projectId), gt(events.ts, cursor)))
          .orderBy(asc(events.ts))
          .limit(200);

        for (const row of rows) {
          const ev = asEventRow(row);
          write(toSse({ event: ev }));
          const ts = new Date(ev.ts);
          if (ts > cursor) cursor = ts;
        }

        write(`: heartbeat ${Date.now()}\n\n`);
        await new Promise((r) => setTimeout(r, 750));
      }

      controller.close();
    },
    async cancel() {
      closed = true;
      await pool.end();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
}
