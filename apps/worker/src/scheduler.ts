import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runs } from '@ocdash/db/schema';

import { requireEnv } from './env.js';

const DATABASE_URL = requireEnv('DATABASE_URL');

const SCHEDULER_ID = String(process.env.OC_DASH_SCHEDULER_ID ?? '').trim() || `scheduler@${process.pid}`;

// Hard limits (initial defaults)
const MAX_ACTIVE_RUNS_GLOBAL = Number(process.env.OC_DASH_MAX_ACTIVE_RUNS_GLOBAL ?? '3');
const MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT = Number(process.env.OC_DASH_MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT ?? '1');

const TICK_MS = Number(process.env.OC_DASH_SCHEDULER_TICK_MS ?? '750');

// Advisory lock key: stable 64-bit int.
// Any constant is fine as long as it's consistent across scheduler instances.
const SCHEDULER_LOCK_KEY = BigInt(process.env.OC_DASH_SCHEDULER_LOCK_KEY ?? '740290112233');

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function schedulerMain() {
  const { db } = makeDb(DATABASE_URL);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Ensure single leader using pg advisory lock.
      const lockRows = await db.execute(sql`
        SELECT pg_try_advisory_lock(${SCHEDULER_LOCK_KEY}) AS locked
      `);

      const locked = Boolean((lockRows as any)?.rows?.[0]?.locked ?? (lockRows as any)?.[0]?.locked);
      if (!locked) {
        await sleep(TICK_MS);
        continue;
      }

      try {
        await tick(db);
      } finally {
        await db.execute(sql`SELECT pg_advisory_unlock(${SCHEDULER_LOCK_KEY})`);
      }

      await sleep(TICK_MS);
    } catch (err) {
      console.error('[scheduler] tick failed', err);
      await sleep(Math.min(TICK_MS * 2, 2000));
    }
  }
}

async function tick(db: any) {
  // Count active (running/claimed) globally
  const activeRows = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM runs
    WHERE status IN ('running', 'claimed')
  `);
  const active = Number((activeRows as any)?.rows?.[0]?.n ?? (activeRows as any)?.[0]?.n ?? 0);

  const slots = Math.max(0, MAX_ACTIVE_RUNS_GLOBAL - active);
  if (slots <= 0) return;

  // Choose candidate queued runs.
  // NOTE: This is initial/naive selection; we will refine to handle more kinds, retries, etc.
  const now = new Date();

  const candidates = await db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      kind: runs.kind,
      priority: (runs as any).priority,
      nextEligibleAt: (runs as any).nextEligibleAt
    })
    .from(runs)
    .where(
      and(
        eq(runs.status, 'queued' as any),
        or(isNull((runs as any).nextEligibleAt), lte((runs as any).nextEligibleAt, now))
      )
    )
    .orderBy(asc((runs as any).priority), asc(runs.createdAt))
    .limit(slots * 4);

  if (!candidates.length) return;

  // Simple per-project mutation lock: only allow one execute/plan at a time.
  // (Plan is treated as "mutation" here for simplicity; can be relaxed later.)
  const claimed: string[] = [];
  for (const c of candidates) {
    if (claimed.length >= slots) break;

    const isMutation = c.kind === 'execute' || c.kind === 'plan';
    if (isMutation) {
      const perProjRows = await db.execute(sql`
        SELECT count(*)::int AS n
        FROM runs
        WHERE project_id = ${c.projectId}
          AND status IN ('running', 'claimed')
          AND kind IN ('execute','plan')
      `);
      const perProj = Number((perProjRows as any)?.rows?.[0]?.n ?? (perProjRows as any)?.[0]?.n ?? 0);
      if (perProj >= MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT) continue;
    }

    // Claim atomically.
    const updated = await db
      .update(runs)
      .set({
        status: 'claimed' as any,
        claimedBy: SCHEDULER_ID,
        claimedAt: new Date(),
        // clear worker assignment; executor will set workerId
        workerId: null
      })
      .where(and(eq(runs.id, c.id), eq(runs.status, 'queued' as any)))
      .returning({ id: runs.id });

    if (updated.length) claimed.push(c.id);
  }
}
