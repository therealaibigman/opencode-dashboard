import { NextResponse } from 'next/server';
import { and, asc, desc, eq } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { tasks } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const projectId = new URL(req.url).searchParams.get('project_id')?.trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(tasks.updatedAt), asc(tasks.createdAt))
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
    await db.insert(tasks).values({
      id,
      projectId,
      title,
      bodyMd,
      status,
      updatedAt: new Date()
    });

    return NextResponse.json({ task: { id, project_id: projectId, title, body_md: bodyMd, status } }, { status: 201 });
  } finally {
    await pool.end();
  }
}
