import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { projects } from '@ocdash/db/schema';
import { newId, prepareWorkspaceForProject } from '@ocdash/shared';
import { appendProjectEvent } from '../../../_lib/eventlog';

export const runtime = 'nodejs';

const WORKSPACES_ROOT =
  process.env.PROJECT_WORKSPACES_ROOT ?? '/home/exedev/.openclaw/workspace/opencode-workspaces';

export async function POST(_req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const pid = (projectId ?? '').trim();
  if (!pid) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(projects).where(eq(projects.id, pid)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const p = rows[0]!;

    try {
      const prep = await prepareWorkspaceForProject({
        root: WORKSPACES_ROOT,
        project: {
          id: p.id,
          localPath: p.localPath,
          repoUrl: p.repoUrl,
          defaultBranch: p.defaultBranch
        }
      });

      await appendProjectEvent({
        databaseUrl: url,
        projectId: p.id,
        type: 'tool.call.completed',
        source: 'api',
        payload: {
          tool: 'project.sync',
          result: {
            mode: prep.mode,
            workspace: prep.workspace,
            local_path: p.localPath ?? null,
            repo_url: p.repoUrl ?? null,
            default_branch: p.defaultBranch ?? null
          }
        }
      } as any);

      return NextResponse.json({ ok: true, mode: prep.mode, workspace: prep.workspace }, { status: 200 });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      await appendProjectEvent({
        databaseUrl: url,
        projectId: p.id,
        type: 'tool.call.failed',
        source: 'api',
        severity: 'error',
        payload: { tool: 'project.sync', error: msg }
      } as any);

      return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
  } finally {
    await pool.end();
  }
}
