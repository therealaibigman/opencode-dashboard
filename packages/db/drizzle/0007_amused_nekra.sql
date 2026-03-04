-- ocdash:allow-destructive (historic migration; reviewed)
ALTER TABLE "runs" DROP CONSTRAINT "runs_parent_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pr_url" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pr_branch" text;