# OpenCode Dashboard

Control plane (Next.js + Postgres + worker) that wraps an OpenCode runtime and provides:
- Projects + tasks
- Runs + live event timeline (SSE with polling fallback)
- Artifacts (stdout/stderr/patches)
- Approval gate (manual + auto paths) with basic policy controls

Deployed path assumption: if you serve under `/ocdash`, ensure your reverse proxy and env match.

## Prereqs
- Node 22+
- npm
- Docker (for Postgres)
- `opencode` installed on the same host as the worker (for real runs)

## Setup
```bash
cd opencode-dashboard
cp .env.example .env

# Postgres
docker compose -f infra/docker/docker-compose.yml up -d

npm install

# create tables (first time)
npm run db:generate
npm run db:migrate
```

## Run (dev)
```bash
npm -w @ocdash/web run dev
npm -w @ocdash/worker run dev
```

## Env notes
- `DATABASE_URL` (required)
- `OPENCODE_STUB=1` to run without provider keys (smoke testing)
- `OPENCODE_MODEL=openrouter/...` to pin the model
- `OC_DASH_REQUIRE_APPROVAL=1` forces `needs_approval` for any patch (testing approvals)

## Test (quick)
Create a project + task in the UI, then queue a run.

## Test SSE (manual)
1) Insert a demo run row:
```sql
insert into projects (id, name) values ('prj_demo','Demo');
insert into runs (id, project_id, status) values ('run_demo','prj_demo','queued');
```
2) Open:
- http://localhost:3000/demo

Worker will pick up `queued` runs and emit events. Web streams them at:
- `GET /api/runs/run_demo/events/stream`

## Deploy notes (nginx)
For SSE routes, ensure proxy buffering is disabled and timeouts are long.
Typical settings:
- `proxy_buffering off;`
- `proxy_read_timeout 3600s;`
