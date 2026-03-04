-- 0014_sync_theme_settings.sql
-- Adds a global app settings row for cross-client preferences (e.g. theme).

CREATE TABLE IF NOT EXISTS "app_settings" (
  "id" text PRIMARY KEY,
  "theme" text NOT NULL DEFAULT 'dark',
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "app_settings_updated_idx" ON "app_settings" ("updated_at");
