import { NextResponse } from 'next/server';
import { and, eq, gte } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { events } from '@ocdash/db/schema';
import { toSse } from '@ocdash/shared';
import { asEventRow } from '../../../../_lib/eventlog';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const afterSeq = Number(sp.get('after_seq') ?? '0') || 0;

  const { db, pool } = makeDb(url);

  let closed = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
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
          write(toSse(ev));
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
