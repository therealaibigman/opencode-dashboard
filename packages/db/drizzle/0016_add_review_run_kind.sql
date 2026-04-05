-- 0016_add_review_run_kind.sql
-- Add 'review' to run_kind enum so we can represent coder↔reviewer loop runs.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'run_kind') THEN
    RAISE EXCEPTION 'run_kind enum missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'run_kind'::regtype AND enumlabel = 'review') THEN
    ALTER TYPE run_kind ADD VALUE 'review';
  END IF;
END $$;
