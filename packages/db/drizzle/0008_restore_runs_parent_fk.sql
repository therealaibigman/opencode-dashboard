-- Restore the self-referencing foreign key for runs.parent_run_id.
-- (A prior migration dropped it accidentally.)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'runs_parent_run_id_runs_id_fk'
  ) THEN
    ALTER TABLE "runs"
      ADD CONSTRAINT "runs_parent_run_id_runs_id_fk"
      FOREIGN KEY ("parent_run_id")
      REFERENCES "public"."runs"("id")
      ON DELETE SET NULL;
  END IF;
END $$;
