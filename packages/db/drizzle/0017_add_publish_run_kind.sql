-- 0017_add_publish_run_kind.sql
-- Add 'publish' to run_kind enum so scheduler can enqueue publish runs after review pass.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'run_kind') THEN
    RAISE EXCEPTION 'run_kind enum missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = 'run_kind'::regtype AND enumlabel = 'publish') THEN
    ALTER TYPE run_kind ADD VALUE 'publish';
  END IF;
END $$;
