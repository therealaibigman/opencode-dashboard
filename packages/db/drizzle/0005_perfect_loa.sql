ALTER TABLE "tasks" ADD COLUMN "position" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_ordering_idx" ON "tasks" USING btree ("project_id","status","position");