# OpenCode Dashboard (scaffold)

Control plane (Next.js + Postgres + worker) that will wrap an OpenCode runtime.

## Prereqs
- Node 22+
- npm
- Docker (for Postgres)

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

## Run
```bash
npm -w @ocdash/web run dev
npm -w @ocdash/worker run dev
```

## Test SSE
1) Insert a demo run row:
```sql
insert into projects (id, name) values ('prj_demo','Demo');
insert into runs (id, project_id, status) values ('run_demo','prj_demo','queued');
```
2) Open:
- http://localhost:3000/demo

Worker will pick up `queued` runs and emit events. Web streams them at:
- `GET /api/runs/run_demo/events/stream`
