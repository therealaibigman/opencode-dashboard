import { NextResponse } from 'next/server';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { tasks } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import { appendProjectEvent } from '../_lib/eventlog';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const sp = new URL(req.url).searchParams;
  const projectId = sp.get('project_id')?.trim();
  const includeArchived = sp.get('include_archived') === '1';

  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const where = includeArchived
      ? eq(tasks.projectId, projectId)
      : and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt));

    const rows = await db
      .select()
      .from(tasks)
      .where(where)
      .orderBy(asc(tasks.status), asc(tasks.position), desc(tasks.updatedAt), asc(tasks.createdAt))
      .limit(500);

    return NextResponse.json({ tasks: rows });
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
    title?: string;
    body_md?: string;
    status?: 'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';
  };

  const projectId = (body.project_id ?? '').trim();
  const title = (body.title ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });

  const id = (body.id ?? newId('tsk')).trim();
  const status = body.status ?? 'inbox';
  const bodyMd = body.body_md ?? '';

  const { db, pool } = makeDb(url);
  try {
    // Put new tasks at the end of their column.
    const [{ maxPos }] = await db
      .select({ maxPos: sql<number | null>`max(${tasks.position})` })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.status, status), isNull(tasks.archivedAt)));

    const position = (Number.isFinite(maxPos as any) ? Number(maxPos) : 0) + 1;

    await db.insert(tasks).values({
      id,
      projectId,
      title,
      bodyMd,
      status,
      position,
      updatedAt: new Date()
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId,
      taskId: id,
      type: 'task.created',
      payload: { task: { id, project_id: projectId, title, body_md: bodyMd, status, position } }
    });

    return NextResponse.json(
      { task: { id, project_id: projectId, title, body_md: bodyMd, status, position } },
      { status: 201 }
    );
  } finally {
    await pool.end();
  }
}
