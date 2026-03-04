import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runs } from '@ocdash/db/schema';
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
      ? and(eq(runs.projectId, projectId), eq(runs.taskId, taskId))
      : eq(runs.projectId, projectId);

    const rows = await db.select().from(runs).where(where).orderBy(desc(runs.createdAt)).limit(200);
    return NextResponse.json({ runs: rows });
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
    model_profile?: string;
    kind?: 'execute' | 'plan';
  };

  const projectId = (body.project_id ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const id = (body.id ?? newId('run')).trim();
  const taskId = body.task_id ?? null;
  const modelProfile = (body.model_profile ?? 'balanced').trim();
  const kind = body.kind ?? 'execute';

  const { db, pool } = makeDb(url);
  try {
    await db.insert(runs).values({
      id,
      projectId,
      taskId,
      modelProfile,
      kind,
      status: 'queued'
    });

    await appendProjectEvent({
      databaseUrl: url,
      projectId,
      taskId,
      runId: id,
      type: 'run.created',
      payload: { run: { id, project_id: projectId, task_id: taskId, model_profile: modelProfile, kind } }
    });

    return NextResponse.json({ run: { id } }, { status: 201 });
  } finally {
    await pool.end();
  }
}
