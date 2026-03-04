ALTER TABLE "runs" ADD COLUMN "pr_number" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pr_repo" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pr_state" text;