# OpenCode Dashboard

Next.js + Postgres + worker control plane for running `opencode run` locally.

## Dev

- `npm install`
- `npm run db:migrate`
- `npm run dev`

## CI / Migrations Guard

This repo includes a destructive-migration guard:

- `npm run check:migrations`

CI will fail if a migration contains destructive statements like `DROP CONSTRAINT`, `DROP COLUMN`, etc.

If a destructive migration is intentional, add this comment to the SQL file:

```sql
-- ocdash:allow-destructive
```

## Deployment (systemd + nginx)

Example unit files:

- `infra/systemd/ocdash-web.service`
- `infra/systemd/ocdash-worker.service`

Example nginx config:

- `infra/nginx/ocdash.conf`

Checklist:

- Web basePath is `/ocdash`
- Ensure `opencode` is installed + authenticated on the host
- Ensure `gh auth login` is done if you want auto PR creation
- Check `/ocdash/api/health`
