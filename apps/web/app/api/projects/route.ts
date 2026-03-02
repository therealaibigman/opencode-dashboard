import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { makeDb } from '@ocdash/db/client';
import { projects } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';

export const runtime = 'nodejs';

export async function GET() {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(projects).orderBy(asc(projects.name));
    return NextResponse.json({ projects: rows });
  } finally {
    await pool.end();
  }
}

export async function POST(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as { name?: string; id?: string };
  const name = (body.name ?? '').trim();
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const projectId = (body.id ?? newId('prj')).trim();

  const { db, pool } = makeDb(url);
  try {
    const existing = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (existing.length) {
      await db.update(projects).set({ name }).where(eq(projects.id, projectId));
    } else {
      await db.insert(projects).values({ id: projectId, name });
    }

    return NextResponse.json({ project: { id: projectId, name } }, { status: 201 });
  } finally {
    await pool.end();
  }
}
