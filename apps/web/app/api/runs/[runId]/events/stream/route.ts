import { eq, and, gte } from 'drizzle-orm';
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

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return new Response('DATABASE_URL missing', { status: 500 });

  const afterSeq = Number(new URL(req.url).searchParams.get('after_seq') ?? '0');
  const { db, pool } = makeDb(url);

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s));

      write(`: stream started for ${runId}\n\n`);

      let cursor = afterSeq;
      while (!closed) {
        const rows = await db
          .select()
          .from(events)
          .where(and(eq(events.runId, runId), gte(events.seq, cursor + 1)))
          .orderBy(events.seq)
          .limit(200);

        for (const row of rows) {
          const ev = asEventRow(row);
          write(toSse({ event: ev }));
          cursor = Math.max(cursor, ev.seq);
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
