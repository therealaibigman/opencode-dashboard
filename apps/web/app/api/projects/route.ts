import { NextResponse } from 'next/server';
import { makeDb } from '@ocdash/db/client';
import { projects } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as { name?: string; id?: string };
  const name = (body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const projectId = (body.id ?? newId('prj')).trim();

  const { db, pool } = makeDb(url);
  try {
    await db.insert(projects).values({ id: projectId, name });
    return NextResponse.json({ project: { id: projectId, name } }, { status: 201 });
  } finally {
    await pool.end();
  }
}
