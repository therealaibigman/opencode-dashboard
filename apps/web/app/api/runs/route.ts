import { NextResponse } from 'next/server';
import { makeDb } from '@ocdash/db/client';
import { runs } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    project_id?: string;
    task_id?: string | null;
    model_profile?: string;
  };

  const projectId = (body.project_id ?? '').trim();
  if (!projectId) return NextResponse.json({ error: 'project_id is required' }, { status: 400 });

  const runId = (body.id ?? newId('run')).trim();
  const modelProfile = (body.model_profile ?? 'balanced').trim();
  const taskId = body.task_id ?? null;

  const { db, pool } = makeDb(url);
  try {
    await db.insert(runs).values({
      id: runId,
      projectId,
      taskId,
      status: 'queued',
      modelProfile
    });

    return NextResponse.json(
      {
        run: {
          id: runId,
          project_id: projectId,
          task_id: taskId,
          status: 'queued',
          model_profile: modelProfile
        }
      },
      { status: 201 }
    );
  } finally {
    await pool.end();
  }
}
