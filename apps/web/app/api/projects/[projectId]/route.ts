import { NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { events, projects, runs } from '@ocdash/db/schema';

export const runtime = 'nodejs';

export async function PATCH(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const pid = (projectId ?? '').trim();
  if (!pid) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    local_path?: string | null;
    repo_url?: string | null;
    default_branch?: string | null;
    plan_model?: string | null;
    execute_model?: string | null;
  };

  const { db, pool } = makeDb(url);
  try {
    const updates: any = {};
    if (typeof body.name === 'string') updates.name = body.name.trim();
    if ('local_path' in body) updates.localPath = (body.local_path ?? null) && String(body.local_path).trim();
    if ('repo_url' in body) updates.repoUrl = (body.repo_url ?? null) && String(body.repo_url).trim();
    if ('default_branch' in body)
      updates.defaultBranch = (body.default_branch ?? null) && String(body.default_branch).trim();

    // normalize empty strings to null
    for (const k of ['localPath', 'repoUrl', 'defaultBranch', 'planModel', 'executeModel']) {
      if (updates[k] === '') updates[k] = null;
    }

    const rows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    await db.update(projects).set(updates).where(eq(projects.id, pid));

    const updated = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
    return NextResponse.json({ ok: true, project: updated[0] }, { status: 200 });
  } finally {
    await pool.end();
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const pid = (projectId ?? '').trim();
  if (!pid) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    // events table has no FK; delete it explicitly to avoid orphan logs.
    const runRows = await db.select({ id: runs.id }).from(runs).where(eq(runs.projectId, pid));
    const runIds = runRows.map((r) => r.id);

    if (runIds.length) {
      await db.delete(events).where(inArray(events.runId, runIds));
    }
    await db.delete(events).where(eq(events.projectId, pid));

    // projects cascades to tasks/runs/artifacts via FK constraints.
    const deleted = await db.delete(projects).where(eq(projects.id, pid));

    return NextResponse.json({ ok: true, project_id: pid, deleted }, { status: 200 });
  } finally {
    await pool.end();
  }
}
