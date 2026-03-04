import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { appSettings } from '@ocdash/db/schema';

export const runtime = 'nodejs';

const GLOBAL_ID = 'global';

export async function GET() {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const { db, pool } = makeDb(url);
  try {
    const rows = await db.select().from(appSettings).where(eq(appSettings.id, GLOBAL_ID)).limit(1);
    if (rows.length) return NextResponse.json({ settings: { theme: rows[0]!.theme } });

    await db.insert(appSettings).values({ id: GLOBAL_ID, theme: 'dark' });
    return NextResponse.json({ settings: { theme: 'dark' } });
  } finally {
    await pool.end();
  }
}

export async function PATCH(req: Request) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const body = (await req.json().catch(() => ({}))) as { theme?: unknown };
  const theme = String(body.theme ?? '').trim();
  if (theme !== 'dark' && theme !== 'light') {
    return NextResponse.json({ error: 'theme must be dark|light' }, { status: 400 });
  }

  const { db, pool } = makeDb(url);
  try {
    const existing = await db.select().from(appSettings).where(eq(appSettings.id, GLOBAL_ID)).limit(1);
    if (!existing.length) {
      await db.insert(appSettings).values({ id: GLOBAL_ID, theme });
    } else {
      await db
        .update(appSettings)
        .set({ theme, updatedAt: new Date() })
        .where(eq(appSettings.id, GLOBAL_ID));
    }

    return NextResponse.json({ settings: { theme } });
  } finally {
    await pool.end();
  }
}
