import { NextResponse } from 'next/server';
import { and, eq, gt } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { events } from '@ocdash/db/schema';
import { toSse } from '@ocdash/shared';
import { asEventRow } from '../../../../_lib/eventlog';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const afterTsRaw = sp.get('after_ts');
  let cursorTs = afterTsRaw ? new Date(afterTsRaw) : new Date(0);

  const { db, pool } = makeDb(url);

  let closed = false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const write = (s: string) => controller.enqueue(encoder.encode(s));
      write(`: project stream started for ${projectId}\n\n`);

      while (!closed) {
        const rows = await db
          .select()
          .from(events)
          .where(and(eq(events.projectId, projectId), gt(events.ts, cursorTs)))
          .orderBy(events.ts)
          .limit(200);

        for (const row of rows) {
          const ev = asEventRow(row);
          write(toSse(ev));

          if (ev.ts) {
            const t = new Date(ev.ts);
            if (!Number.isNaN(t.getTime()) && t > cursorTs) cursorTs = t;
          }
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
