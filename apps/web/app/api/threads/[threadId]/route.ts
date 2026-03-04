import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { threads } from '@ocdash/db/schema';
import { appendProjectEvent } from '../../_lib/eventlog';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const tid = (threadId ?? '').trim();
  if (!tid) return NextResponse.json({ error: 'threadId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(threads).where(eq(threads.id, tid)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ thread: rows[0] });
  } finally {
    await pool.end();
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const tid = (threadId ?? '').trim();
  if (!tid) return NextResponse.json({ error: 'threadId is required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const title = String(body.title ?? '').trim();

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(threads).where(eq(threads.id, tid)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const thr = rows[0]!;
    await db.update(threads).set({ title, updatedAt: new Date() }).where(eq(threads.id, tid));

    await appendProjectEvent({
      databaseUrl: url,
      projectId: thr.projectId,
      taskId: thr.taskId ?? null,
      threadId: tid,
      type: 'thread.updated',
      payload: { thread: { id: tid, title } }
    });

    return NextResponse.json({ ok: true });
  } finally {
    await pool.end();
  }
}
