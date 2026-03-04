import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { pipelines } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';

export const runtime = 'nodejs';

export async function GET() {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(pipelines).orderBy(asc(pipelines.name), asc(pipelines.createdAt)).limit(100);
    return NextResponse.json({ pipelines: rows });
  } finally {
    await pool.end();
  }
}

export async function POST(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    version?: string;
    graph_json?: unknown;
    create_default?: boolean;
  };

  const { db, pool } = makeDb(url);
  try {
    if (body.create_default) {
      const existing = await db.select().from(pipelines).where(eq(pipelines.name, 'GSD Feature PR')).limit(1);
      if (existing.length) return NextResponse.json({ pipeline: existing[0] }, { status: 200 });

      const id = newId('pip');
      const graph = {
        id: 'gsd-feature-pr-v1',
        nodes: [
          { id: 'intake', kind: 'intake' },
          { id: 'plan', kind: 'plan' },
          { id: 'execute', kind: 'execute' },
          { id: 'checks', kind: 'checks' },
          { id: 'publish', kind: 'publish' },
          { id: 'summary', kind: 'summary' }
        ],
        edges: [
          ['intake', 'plan'],
          ['plan', 'execute'],
          ['execute', 'checks'],
          ['checks', 'publish'],
          ['publish', 'summary']
        ]
      };

      await db.insert(pipelines).values({ id, name: 'GSD Feature PR', version: 'v1', graphJson: graph });
      const rows = await db.select().from(pipelines).where(eq(pipelines.id, id)).limit(1);
      return NextResponse.json({ pipeline: rows[0] }, { status: 201 });
    }

    const name = String(body.name ?? '').trim();
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

    const id = (body.id ?? newId('pip')).trim();
    const version = String(body.version ?? 'v1').trim() || 'v1';
    const graphJson = body.graph_json ?? {};

    await db.insert(pipelines).values({ id, name, version, graphJson });
    const rows = await db.select().from(pipelines).where(eq(pipelines.id, id)).limit(1);
    return NextResponse.json({ pipeline: rows[0] }, { status: 201 });
  } finally {
    await pool.end();
  }
}
