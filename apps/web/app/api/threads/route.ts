import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { threads } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import { appendProjectEvent } from '../_lib/eventlog';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const projectId = sp.get('project_id')?.trim();
  const taskId = sp.get('task_id')?.trim();

  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const where = taskId
      ? and(eq(threads.projectId, projectId), eq(threads.taskId, taskId))
      : eq(threads.projectId, projectId);

    const rows = await db.select().from(threads).where(where).orderBy(desc(threads.updatedAt)).limit(50);
    return NextResponse.json({ threads: rows });
  } finally {
    await pool.end();
  }
}

export async function POST(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    project_id?: string;
    task_id?: string | null;
    title?: string;
  };

  const projectId = (body.project_id ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const id = (body.id ?? newId('thr')).trim();
  const taskId = body.task_id ? String(body.task_id).trim() : null;
  const title = String(body.title ?? '').trim();

  const { db, pool } = makeDb(url);
  try {
    await db.insert(threads).values({
      id,
      projectId,
      taskId,
      title,
      updatedAt: new Date()
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId,
      taskId,
      threadId: id,
      type: 'thread.created',
      payload: { thread: { id, project_id: projectId, task_id: taskId, title } }
    });

    return NextResponse.json({ thread: { id } }, { status: 201 });
  } finally {
    await pool.end();
  }
}
