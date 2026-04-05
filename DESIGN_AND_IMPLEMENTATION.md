# OpenCode Dashboard (ocdash) — Design & Implementation Context

Date: 2026-04-05

This document exists to give **future AI agents and human contributors** a complete, accurate mental model of what ocdash is, how it is structured, and how to extend it without breaking the orchestration spine.

If you only read one thing first, read `README.md`. If you’re working on the authoritative orchestrator, also read `ORCHESTRATOR_SPEC.md`.

---

## 1) What this software is (plain English)

**ocdash is a local-first control plane for AI-driven development work.**

It:
- manages **projects** (a repo URL or a local path mirrored into a controlled workspace)
- tracks **tasks** (Kanban + metadata)
- runs **jobs (“runs”)** against those projects using an OpenCode-style worker
- stores **receipts** (events, artifacts, messages) so execution is auditable
- supports **approval gates** for risky actions
- supports **pipelines (“GSD”)** for multi-step DAG execution
- supports **multiple workers** with a **single authoritative scheduler** (bounded concurrency, heartbeats, retries)

The key rule: **Postgres is the source of truth.** No “ghost state” living only in memory.

---

## 2) The big components

Monorepo layout:

- `apps/web` — Next.js dashboard UI + API routes
- `apps/worker` — the executor (and also the scheduler when `OC_DASH_MODE=scheduler`)
- `packages/db` — Drizzle schema + migrations + DB client
- `packages/shared` — shared utilities (IDs, etc.)
- `infra/` — example systemd + nginx configs

Runtime roles:

### Web (UI + API)
- Serves the UI
- Exposes API routes used by the UI (`/api/*`)
- Writes/reads DB state

### Scheduler (single leader)
- A loop that:
  - enforces concurrency limits
  - claims eligible runs
  - reaps stuck runs (claim timeout + heartbeat timeout)
  - applies retry/backoff policy

### Workers (N executors)
- Poll for claimed runs (prefers `claimed`, may have fallback logic)
- Transition `claimed → running → terminal`
- Write `heartbeat_at` while working
- Emit receipts (events, artifacts, thread messages)

---

## 3) The database model (the parts that matter)

This repo uses Drizzle with Postgres.

Conceptual entities:

- **projects** — repo/local path configuration, default branch, model prefs, etc.
- **tasks** — Kanban items
- **threads/messages** — chat history tied to tasks/runs
- **runs** — the unit of work
- **run_steps** — step-level execution for pipelines
- **artifacts** — outputs like plan JSON, patch diffs, etc.
- **events** — append-only log for UI timelines/feeds
- **pipelines** — stored graphs (JSON) that define multi-step DAG execution

### Run orchestration fields
These fields are what make multi-worker safe:

- `runs.status` (enum): includes `queued`, `claimed`, `running`, `needs_approval`, `failed`, `succeeded`, `cancelled`, plus future `retry_wait`, `cancelling`
- `runs.claimed_by`, `runs.claimed_at`: set by scheduler when it claims a run
- `runs.worker_id`: set by worker when it starts execution
- `runs.heartbeat_at`: periodically updated while running
- `runs.attempt_count`: incremented on reaping/retries
- `runs.next_eligible_at`: eligibility gate for retries/backoff
- `runs.priority`: scheduling preference
- `runs.loop_index`: reserved for future coder↔reviewer loop

The orchestration spine is intentionally DB-first: **if it isn’t in Postgres, it doesn’t exist.**

---

## 4) The run lifecycle

### Non-pipeline runs (simple)
Typical:

1. UI/API inserts a run with `status='queued'`.
2. Scheduler selects eligible queued runs and atomically updates them to:
   - `status='claimed'`
   - sets `claimed_by`, `claimed_at`
   - clears `worker_id`
3. Worker finds claimed runs, updates the run to:
   - `status='running'`
   - sets `worker_id`
   - sets initial `heartbeat_at`
4. Worker executes and finishes:
   - `succeeded` or `failed` or `needs_approval` or `cancelled`

### Approval gates
Runs may stop at `needs_approval` if:
- a plan requires approval
- a patch/diff requires approval

UI provides approve/reject endpoints. Approval commonly spawns the next run (plan → execute).

---

## 5) Pipelines / “GSD”

**GSD is pipeline execution.**

A pipeline is a stored graph (DAG) describing steps. When a run is created with `pipeline_id`:

- the worker loads the pipeline graph
- it pre-creates `run_steps` rows for each node
- it executes steps in dependency order (“waves”)
- receipts are still written to threads/events/artifacts

Practical take:
- If you want deterministic multi-step automation (plan → execute → review → publish), use a pipeline.
- If you want one-shot work, use a plain run.

---

## 6) Scheduler details (leader election, claiming, limits)

Scheduler implementation lives in:
- `apps/worker/src/scheduler.ts`

Key properties:

### Leader election
- Uses Postgres advisory lock (`pg_try_advisory_lock`) so only one scheduler loop is active.

### Claiming
- Scheduler selects eligible queued runs (respects `next_eligible_at`)
- Atomically claims per run via `UPDATE ... WHERE status='queued' RETURNING ...`

### Concurrency limits
- Global active limit: `OC_DASH_MAX_ACTIVE_RUNS_GLOBAL` (default 3)
- Per-project mutation limit: `OC_DASH_MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT` (default 1)
  - currently treats `kind in (plan, execute)` as “mutation”

### Stuck-run reaping
Scheduler reaps stuck runs:
- `claimed` with no heartbeat after `OC_DASH_STUCK_CLAIM_MS`
- stale heartbeat after `OC_DASH_STUCK_HEARTBEAT_MS`

Reaping:
- increments `attempt_count`
- sets `next_eligible_at` (exponential backoff, capped)
- requeues, or fails after `OC_DASH_MAX_ATTEMPTS`

Design intent:
- Prefer **at-least-once** execution with reaping + safe behaviour.
- “Exactly once” is not realistic without heavy idempotency work; the system should move toward safe retries.

---

## 7) Web UI + API conventions

The Next.js app (`apps/web`) provides:
- UI panels (Chat, Kanban, Runs, GSD, Settings)
- API routes under `apps/web/app/api/*`

Notable routes:
- `/api/runs` (list/create)
- `/api/runs/[runId]` (details)
- `/api/projects/*`, `/api/tasks/*`, `/api/threads/*`
- `/api/health`

Admin/observability:
- `/admin/runs` shows retry/backoff signals (`attempt_count`, `next_eligible_at`) via `/api/admin/runs`

UI rule:
- Respect basePath; don’t hardcode `/ocdash` into navigation.

---

## 8) Systemd deployment (current state)

The repo includes units + an installer:

- `infra/systemd/ocdash-scheduler.service`
- `infra/systemd/ocdash-worker@.service`
- `scripts/install-systemd-orchestrator.sh`

Current note:
- Units start worker in **dev/watch** mode (`tsx watch`). That’s acceptable for a dev host, not ideal for production.

---

## 9) How to verify “it works” (built status)

Use the README Quickstart + Chaos test.

Minimum proofs:
- Scheduler claims runs; workers execute them.
- Killing a worker mid-run results in:
  - reaping
  - `attempt_count` increments
  - backoff visible in `/admin/runs`
  - eventual success or controlled failure

---

## 10) Extension guidelines (don’t break the spine)

When changing orchestration:

1. **Never invent new in-memory state** that can’t be derived from the DB.
2. **Keep run transitions atomic** (DB guard in `WHERE` clause).
3. **Heartbeats must be cheap** and safe to fail (best effort).
4. **Retries must be explicit** (`attempt_count`, `next_eligible_at`, and clear reasons in artifacts/events if possible).
5. **Avoid duplicate execution** by tightening claim semantics, not by hoping workers behave.

When adding features:
- Prefer append-only **events/artifacts** over silent mutations.
- If destructive, add approval gates.

---

## 11) Known gaps / roadmap pointers

The authoritative spine is a first cut. Likely next work:

- Make claim ownership semantics stricter (scheduler claim vs worker ownership)
- Add repo-level locks (not just project-level mutation guard)
- Formalize run kinds (`plan`, `execute`, `review`, `publish`) and loop state machine
- Enforce PR-only publish path (block pushing to main/master)
- Add explicit reaping reason + last error fields (better admin visibility)

---

## 12) File map (quick links)

- README: `README.md`
- Orchestrator roadmap/spec: `ORCHESTRATOR_SPEC.md`
- Scheduler: `apps/worker/src/scheduler.ts`
- Worker main: `apps/worker/src/index.ts`
- Admin retries UI: `apps/web/app/admin/runs/page.tsx` + `apps/web/components/AdminRunsPanel.tsx`
- Admin API: `apps/web/app/api/admin/runs/route.ts`
- Systemd installer: `scripts/install-systemd-orchestrator.sh`
- Migrations: `packages/db/drizzle/*.sql`

---

## 13) Glossary

- **Run**: a job instance (plan/execute or pipeline-backed)
- **Claim**: scheduler assigning a run for execution (DB state change)
- **Heartbeat**: periodic DB timestamp indicating liveness
- **Reaping**: scheduler re-queues or fails a stuck run
- **Backoff**: delay before retry (stored as `next_eligible_at`)
- **GSD**: the pipeline-based execution mode in the UI
