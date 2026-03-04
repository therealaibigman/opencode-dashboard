import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { messages, threads } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import { appendProjectEvent } from '../../../_lib/eventlog';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const tid = (threadId ?? '').trim();
  if (!tid) return NextResponse.json({ error: 'threadId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(messages).where(eq(messages.threadId, tid)).orderBy(asc(messages.createdAt)).limit(500);
    return NextResponse.json({ messages: rows });
  } finally {
    await pool.end();
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const tid = (threadId ?? '').trim();
  if (!tid) return NextResponse.json({ error: 'threadId is required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    role?: 'user' | 'assistant' | 'system';
    content_md?: string;
  };

  const role = (body.role ?? 'user').trim();
  const content = String(body.content_md ?? '').trim();
  if (!content) return NextResponse.json({ error: 'content_md is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const trows = await db.select().from(threads).where(eq(threads.id, tid)).limit(1);
    if (!trows.length) return NextResponse.json({ error: 'thread not found' }, { status: 404 });

    const thr = trows[0]!;
    const id = (body.id ?? newId('msg')).trim();

    await db.insert(messages).values({
      id,
      projectId: thr.projectId,
      threadId: tid,
      role,
      contentMd: content
    });

    await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, tid));

    await appendProjectEvent({
      databaseUrl: url,
      projectId: thr.projectId,
      taskId: thr.taskId ?? null,
      threadId: tid,
      type: 'message.created',
      payload: { message: { id, thread_id: tid, role, content_md: content } }
    });

    return NextResponse.json({ message: { id } }, { status: 201 });
  } finally {
    await pool.end();
  }
}
