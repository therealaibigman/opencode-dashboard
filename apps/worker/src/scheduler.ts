import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { makeDb } from '@ocdash/db/client';
import { runs } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';

import { requireEnv } from './env.js';

const DATABASE_URL = requireEnv('DATABASE_URL');

const SCHEDULER_ID = String(process.env.OC_DASH_SCHEDULER_ID ?? '').trim() || `scheduler@${process.pid}`;

// Hard limits (initial defaults)
const MAX_ACTIVE_RUNS_GLOBAL = Number(process.env.OC_DASH_MAX_ACTIVE_RUNS_GLOBAL ?? '3');
const MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT = Number(process.env.OC_DASH_MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT ?? '1');

const TICK_MS = Number(process.env.OC_DASH_SCHEDULER_TICK_MS ?? '750');

// Stuck-run reaping
const STUCK_CLAIM_MS = Number(process.env.OC_DASH_STUCK_CLAIM_MS ?? '30000'); // claimed but never heartbeated
const STUCK_HEARTBEAT_MS = Number(process.env.OC_DASH_STUCK_HEARTBEAT_MS ?? '60000'); // running/claimed and heartbeat stopped
const MAX_ATTEMPTS = Number(process.env.OC_DASH_MAX_ATTEMPTS ?? '5');

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


async function maybeEnqueueReviewRuns(db: any) {
  // Ralph loop (phase 1): after an execute run succeeds, enqueue a review run if missing.
  // Intentionally simple: scheduler only spawns review; it does not yet react to verdicts.

  const candidates = await db.execute(sql`
    SELECT r.id, r.project_id, r.task_id, r.thread_id, r.model_profile, r.loop_index
    FROM runs r
    WHERE r.kind = 'execute'::run_kind
      AND r.status = 'succeeded'::run_status
      AND NOT EXISTS (
        SELECT 1 FROM runs c
        WHERE c.parent_run_id = r.id
          AND c.kind = 'review'::run_kind
      )
    ORDER BY r.finished_at DESC NULLS LAST, r.created_at DESC
    LIMIT 10
  `);

  const rows = (candidates as any)?.rows ?? candidates;
  if (!Array.isArray(rows) || rows.length === 0) return;

  let n = 0;
  for (const r of rows) {
    const runId = newId('run');
    const inserted = await db.execute(sql`
      INSERT INTO runs (id, project_id, task_id, parent_run_id, thread_id, pipeline_id, kind, status, model_profile, loop_index)
      SELECT
        ${runId},
        ${r.project_id},
        ${r.task_id},
        ${r.id},
        ${r.thread_id},
        NULL,
        'review'::run_kind,
        'queued'::run_status,
        ${r.model_profile},
        ${r.loop_index}
      WHERE NOT EXISTS (
        SELECT 1 FROM runs c
        WHERE c.parent_run_id = ${r.id}
          AND c.kind = 'review'::run_kind
      )
      RETURNING id
    `);

    const ins = (inserted as any)?.rows ?? inserted;
    if (Array.isArray(ins) && ins.length) n += 1;
  }

  if (n > 0) console.warn(`[scheduler] enqueued review runs: ${n}`);
}

async function reapStuckRuns(db: any) {
  // Strategy:
  // - If a run is "claimed" but never heartbeated within STUCK_CLAIM_MS, requeue it.
  // - If a run's heartbeat is stale beyond STUCK_HEARTBEAT_MS, requeue it.
  // - Increment attempt_count. If exceeds MAX_ATTEMPTS, mark failed.
  // - next_eligible_at gets a small exponential backoff (1s,2s,4s...) capped at 60s.
  const rows = await db.execute(sql`
    WITH stuck AS (
      SELECT id, attempt_count
      FROM runs
      WHERE status IN ('running','claimed')
        AND (
          (status = 'claimed' AND heartbeat_at IS NULL AND claimed_at IS NOT NULL AND claimed_at < now() - (${STUCK_CLAIM_MS}::int * interval '1 millisecond'))
          OR
          (heartbeat_at IS NOT NULL AND heartbeat_at < now() - (${STUCK_HEARTBEAT_MS}::int * interval '1 millisecond'))
        )
      ORDER BY COALESCE(heartbeat_at, claimed_at) ASC
      LIMIT 25
    )
    UPDATE runs r
    SET
      status = CASE
        WHEN (s.attempt_count + 1) >= ${MAX_ATTEMPTS} THEN 'failed'::run_status
        ELSE 'queued'::run_status
      END,
      attempt_count = s.attempt_count + 1,
      next_eligible_at = CASE
        WHEN (s.attempt_count + 1) >= ${MAX_ATTEMPTS} THEN NULL
        ELSE now() + (LEAST(60, GREATEST(1, power(2, s.attempt_count)::int))::text || ' seconds')::interval
      END,
      claimed_by = NULL,
      claimed_at = NULL,
      worker_id = NULL,
      heartbeat_at = NULL
    FROM stuck s
    WHERE r.id = s.id
    RETURNING r.id, r.status
  `);

  const n = Number((rows as any)?.rows?.length ?? (rows as any)?.length ?? 0);
  if (n > 0) {
    const failed = ((rows as any)?.rows ?? rows).filter((x: any) => x.status === 'failed').length;
    const requeued = n - failed;
    console.warn(`[scheduler] reaped stuck runs: ${n} (requeued=${requeued}, failed=${failed})`);
  }
}

async function tick(db: any) {
  await maybeEnqueueReviewRuns(db);
  await reapStuckRuns(db);

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
