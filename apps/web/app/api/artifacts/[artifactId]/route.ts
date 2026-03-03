import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { artifacts } from '@ocdash/db/schema';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ artifactId: string }> }
) {
  const { artifactId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
    if (!rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const a = rows[0]!;
    return NextResponse.json({
      artifact: {
        id: a.id,
        project_id: a.projectId,
        run_id: a.runId,
        step_id: a.stepId,
        kind: a.kind,
        name: a.name,
        content_text: a.contentText,
        created_at: a.createdAt
      }
    });
  } finally {
    await pool.end();
  }
}
