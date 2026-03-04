import { NextResponse } from 'next/server';
import { execSync } from 'node:child_process';
import os from 'node:os';

import { makeDb } from '@ocdash/db/client';

export const runtime = 'nodejs';

function run(cmd: string) {
  try {
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, timeout: 5000 });
    return { ok: true as const, output: out.toString().trim() };
  } catch (e: any) {
    const msg = String(e?.stderr?.toString?.() ?? e?.message ?? e);
    return { ok: false as const, error: msg.trim() };
  }
}

export async function GET() {
  const url = process.env.DATABASE_URL;
  const dbRes = { ok: false, error: 'DATABASE_URL missing' } as any;

  if (url) {
    try {
      const { pool } = makeDb(url);
      const r = await pool.query('select 1 as ok');
      await pool.end();
      dbRes.ok = r.rows?.[0]?.ok === 1;
      if (!dbRes.ok) dbRes.error = 'db returned unexpected response';
      else delete dbRes.error;
    } catch (e: any) {
      dbRes.ok = false;
      dbRes.error = String(e?.message ?? e);
    }
  }

  const opencodeVer = run('opencode --version');
  const ghStatus = run('gh auth status');

  const disk = run('df -h .');

  return NextResponse.json({
    ok: Boolean(dbRes.ok) && Boolean(opencodeVer.ok),
    host: os.hostname(),
    db: dbRes,
    opencode: opencodeVer,
    gh: ghStatus,
    disk
  });
}
