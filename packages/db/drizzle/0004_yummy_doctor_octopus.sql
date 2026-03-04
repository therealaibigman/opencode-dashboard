CREATE TYPE "public"."run_kind" AS ENUM('execute', 'plan');--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "kind" "run_kind" DEFAULT 'execute' NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_kind_idx" ON "runs" USING btree ("kind");