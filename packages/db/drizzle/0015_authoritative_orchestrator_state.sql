-- 0015_authoritative_orchestrator_state.sql
-- Introduce scheduler/executor-friendly fields so ocdash can support
-- bounded concurrency, safe multi-worker claiming, retries, and heartbeats.

-- 1) Extend enum: run_status
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'run_status') THEN
    RAISE EXCEPTION 'run_status enum missing';
  END IF;

  -- Add new statuses (idempotent)
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'run_status'::regtype AND enumlabel = 'claimed') THEN
    ALTER TYPE run_status ADD VALUE 'claimed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'run_status'::regtype AND enumlabel = 'retry_wait') THEN
    ALTER TYPE run_status ADD VALUE 'retry_wait';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'run_status'::regtype AND enumlabel = 'cancelling') THEN
    ALTER TYPE run_status ADD VALUE 'cancelling';
  END IF;
END $$;

-- 2) Add columns to runs
ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "claimed_by" text,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_eligible_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "priority" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "loop_index" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "runs_claimed_by_idx" ON "runs" ("claimed_by");
CREATE INDEX IF NOT EXISTS "runs_next_eligible_idx" ON "runs" ("next_eligible_at");
CREATE INDEX IF NOT EXISTS "runs_heartbeat_idx" ON "runs" ("heartbeat_at");
CREATE INDEX IF NOT EXISTS "runs_priority_idx" ON "runs" ("priority");
