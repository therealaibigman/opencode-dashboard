import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { tasks } from '@ocdash/db/schema';
import { appendProjectEvent } from '../../_lib/eventlog';

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as {
    status?: 'inbox' | 'planned' | 'in_progress' | 'blocked' | 'review' | 'done';
    title?: string;
    body_md?: string;
    position?: number;
    archived?: boolean;
    archived_at?: string | null;
  };

  const { db, pool } = makeDb(url);
  try {
    const before = await db.select().from(tasks).where(eq(tasks.id, taskId));
    if (!before.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status) patch.status = body.status;
    if (typeof body.title === 'string') patch.title = body.title;
    if (typeof body.body_md === 'string') patch.bodyMd = body.body_md;

    if (typeof body.position === 'number' && Number.isFinite(body.position)) {
      patch.position = body.position;
    }

    if (typeof body.archived === 'boolean') {
      patch.archivedAt = body.archived ? new Date() : null;
    }

    if ('archived_at' in body) {
      patch.archivedAt = body.archived_at ? new Date(String(body.archived_at)) : null;
    }

    await db.update(tasks).set(patch).where(eq(tasks.id, taskId));

    const projectId = before[0]!.projectId;

    if (typeof body.archived === 'boolean' || 'archived_at' in body) {
      await appendProjectEvent({
        databaseUrl: url,
        projectId,
        taskId,
        type: 'task.archived.changed',
        payload: { task_id: taskId, archived: Boolean((patch as any).archivedAt) }
      });
    } else if (body.status) {
      await appendProjectEvent({
        databaseUrl: url,
        projectId,
        taskId,
        type: 'task.status.changed',
        payload: { task_id: taskId, status: body.status }
      });
    } else {
      await appendProjectEvent({
        databaseUrl: url,
        projectId,
        taskId,
        type: 'task.updated',
        payload: { task_id: taskId }
      });
    }

    return NextResponse.json({ ok: true });
  } finally {
    await pool.end();
  }
}
