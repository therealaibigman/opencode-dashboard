# OpenCode Dashboard (ocdash)

A local-first control plane for running OpenCode-style work against **real project workspaces**.

This is not a chatbot toy. It’s an orchestration + pipeline runner with receipts:

- **Projects** (local path mirror or git repo clone)
- **Tasks** (Kanban, ordering, archive/restore)
- **Runs** (plan/execute + timeline + artifacts)
- **Approval gates** (plan approval, patch approval)
- **Pipelines (GSD)** (graph-driven multi-step runs)
- **Multi-worker orchestration spine** (scheduler claims, workers execute, heartbeats + retries)

Deployed basePath: **`/ocdash`**

---

## What it does

### Core workflow (non-pipeline)

1) Create a task (Chat or Kanban)
2) Queue a **Plan** run → produces a plan artifact → may require approval
3) Approve plan → queues an **Execute** run linked to the plan
4) Execute run may:
   - do nothing
   - generate a unified diff (patch artifact)
   - auto-apply + checks + commit + publish (if allowed)
   - or stop at `needs_approval`

### Pipelines (GSD)

GSD runs are **pipeline runs**: a single Run references a `pipeline_id`, and the worker executes a DAG of steps (`run_steps`) in topological “waves”.

Use this when you want **plan → execute → review → publish** (or any graph) as one tracked unit.

---

## Architecture: authoritative orchestrator spine

This repo now supports **bounded concurrency** and **multi-worker execution**.

### Roles

- **Scheduler**: leader-elected loop (Postgres advisory lock). Claims eligible queued runs up to a global limit.
- **Workers**: execute runs, write `heartbeat_at`, and move runs through statuses.

### Key DB fields

- `runs.claimed_by`, `runs.claimed_at`: scheduler claim ownership
- `runs.heartbeat_at`: worker liveness
- `runs.attempt_count`, `runs.next_eligible_at`: retries + backoff
- `runs.priority`, `runs.loop_index`: scheduling controls

### Run statuses (enum)

Includes the original statuses plus:
- `claimed`
- `retry_wait`
- `cancelling`

### Stuck-run reaping

Scheduler reaps stuck runs:
- **Claim timeout**: `claimed` with no heartbeat for `OC_DASH_STUCK_CLAIM_MS`
- **Heartbeat timeout**: stale `heartbeat_at` for `OC_DASH_STUCK_HEARTBEAT_MS`

Reaping increments `attempt_count`, sets `next_eligible_at` (small exponential backoff), and eventually marks `failed` at `OC_DASH_MAX_ATTEMPTS`.

See: `apps/worker/src/scheduler.ts`

---


## Quickstart (authoritative scheduler + 3 workers)

This is the fastest path to a known-good local install.

```bash
# 1) install deps
npm install

# 2) set DB
export DATABASE_URL=postgres://oc:oc@localhost:5432/oc

# 3) migrate
npm run db:migrate

# 4) bring up scheduler + workers (systemd)
sudo ./scripts/install-systemd-orchestrator.sh   --repo "$(pwd)"   --user "$USER"   --workers worker-1,worker-2,worker-3

# 5) run web (dev)
npm -w @ocdash/web run dev
# open: http://localhost:3000/ocdash
```

Notes:
- The systemd units currently run the worker in **dev/watch** mode (`tsx watch`). For true prod, swap to a build + start flow.
- If you don’t want systemd, run the scheduler/workers manually (see below).

## Install

### Prereqs

- Node.js 22+
- Postgres 14+
- `opencode` CLI installed + authenticated
- Optional: `gh` CLI authenticated (for PR creation)

### Clone

```bash
git clone https://github.com/therealaibigman/opencode-dashboard.git
cd opencode-dashboard
npm install
```

### Database

Set `DATABASE_URL` and run migrations:

```bash
export DATABASE_URL="postgres://USER:PASS@localhost:5432/ocdash"
npm run db:migrate
```

---

## Running (dev)

### All apps

```bash
npm run dev
```

### Worker only (dev)

```bash
npm run worker
```

---

## Running (authoritative scheduler + multiple workers)

You run **one scheduler** and **N workers**.

### Manual (foreground)

```bash
# scheduler
OC_DASH_MODE=scheduler npm -w @ocdash/worker run dev

# worker 1
OC_DASH_MODE=worker OC_DASH_WORKER_ID=worker-1 npm -w @ocdash/worker run dev

# worker 2
OC_DASH_MODE=worker OC_DASH_WORKER_ID=worker-2 npm -w @ocdash/worker run dev
```

### systemd (recommended)

This repo includes an installer that sets up:
- `ocdash-scheduler.service`
- `ocdash-worker@.service` (templated; instances become worker IDs)

```bash
sudo ./scripts/install-systemd-orchestrator.sh \
  --repo /home/exedev/.openclaw/workspace/opencode-dashboard \
  --user exedev \
  --workers worker-1,worker-2,worker-3
```

Units live in:
- `infra/systemd/ocdash-scheduler.service`
- `infra/systemd/ocdash-worker@.service`

---

## Configuration (.env)

### Required

- `DATABASE_URL`

### Orchestration / concurrency

- `OC_DASH_MODE=worker|scheduler`
- `OC_DASH_WORKER_ID=worker-1` (for workers)
- `OC_DASH_MAX_ACTIVE_RUNS_GLOBAL=3`
- `OC_DASH_MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT=1`
- `OC_DASH_SCHEDULER_TICK_MS=750`

### Stuck-run reaping

- `OC_DASH_STUCK_CLAIM_MS=30000`
- `OC_DASH_STUCK_HEARTBEAT_MS=60000`
- `OC_DASH_MAX_ATTEMPTS=5`

### Worker runtime

- `OC_DASH_HEARTBEAT_MS=2000`
- `PROJECT_WORKSPACES_ROOT` (default: `~/.openclaw/workspace/opencode-workspaces`)

### Safety / approvals

- `OC_DASH_REQUIRE_APPROVAL=1` forces execute diffs to require approval
- `OC_DASH_AUTO_COMMANDS="npm test,npm run lint,npm run typecheck"`

---


## Chaos test (prove reaping + retries)

This is the “built status” proof that the orchestration spine works under failure.

### Goal

- Start a run.
- Kill a worker mid-run.
- Confirm the scheduler reaps it and retries (attempt_count increments, backoff is visible).

### Steps

1) Open the dashboard and start an **execute** run (or a pipeline run) for any project.

2) In another terminal, kill one worker hard:

```bash
sudo systemctl kill -s SIGKILL ocdash-worker@worker-2.service
```

3) Watch admin view:

- Open: `http://localhost:3000/ocdash/admin/runs`
- Find the affected run.
- Verify:
  - `attempt_count` increases
  - `next_eligible_at` shows backoff (counts down)
  - status returns to `queued` (or `failed` if it hits max attempts)

4) Bring the worker back:

```bash
sudo systemctl start ocdash-worker@worker-2.service
```

5) Confirm the run completes.

### Knobs

- `OC_DASH_STUCK_CLAIM_MS` (default 30s)
- `OC_DASH_STUCK_HEARTBEAT_MS` (default 60s)
- `OC_DASH_MAX_ATTEMPTS` (default 5)

## Admin / Observability

- Health: `GET /ocdash/api/health`
- Admin retries/backoff view: `GET /ocdash/admin/runs`
  - shows `attempt_count` (reaped/retried) and computed backoff from `next_eligible_at`

---

## UI Settings

Settings tab is **local** (stored in browser localStorage):

- Theme toggle (dark/light)
- Model profile default (passed as `model_profile` when queueing runs)
- YOLO mode (UI flag only; real safety is enforced by server env)

---

## Deployment notes

- Nginx example: `infra/nginx/ocdash.conf`
- systemd examples: `infra/systemd/*`

---

## Dev rules (GSD vibe)

- Keep basePath bugs dead: **never hardcode `/ocdash` into router.push**.
- Prefer receipts over vibes: events + artifacts over hidden state.
- If it’s destructive, it needs an approval gate.
