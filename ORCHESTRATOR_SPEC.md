# OCDash Orchestrator (WIP)

Date: 2026-03-07
Status: draft / in-progress implementation

This document captures the “proper path” to make ocdash a control center for AI-driven development across **many repos** with **bounded concurrency**, **PR-only publishing**, and a **coder↔reviewer loop**.

It borrows the key idea from Symphony: a **single authoritative orchestrator state** that survives restarts and prevents duplicate execution.


## Background / rationale (historical note)

The initial motivation for the scheduler/executor split was inspired by Symphony’s “authoritative orchestrator” idea.
If you want the original comparison write-up, see the git history for `future-notes/symphony_comparison.md` (now removed).

## Goals

- Many repos (git URLs + local paths)
- Same machine for now; architecture extendible to multi-machine
- Keep using `opencode run`
- Hard limits set to **3** (global), plus per-repo/per-project mutation locks
- PR-only: never push to `main`/`master`
- Coder agent implements; reviewer agent iterates until “pass” or max loops

## Core idea: scheduler vs executor

- **Scheduler (leader)**
  - Decides what is eligible to run
  - Enforces concurrency limits
  - Claims runs (atomically) for execution
  - Reaps stuck runs based on heartbeats
  - Owns retry/backoff policy

- **Executor / Worker (many)**
  - Picks up *claimed* runs
  - Executes `opencode run` in the workspace
  - Emits events + artifacts
  - Heartbeats while running

Postgres is the source of truth.

## Run lifecycle (initial)

Statuses (enum `run_status`):

- `queued` → `claimed` → `running` → `succeeded|failed|needs_approval|cancelled`
- `retry_wait` (future) for exponential backoff
- `cancelling` (future) when scheduler requests stop

Scheduler selects `queued` (and later `retry_wait` when eligible), then claims to `claimed`.

Executor transitions `claimed → running` and sets `worker_id`.

## Concurrency limits (initial)

Hard limits:

- `OC_DASH_MAX_ACTIVE_RUNS_GLOBAL=3`
- `OC_DASH_MAX_ACTIVE_MUTATION_RUNS_PER_PROJECT=1`

Where “mutation” initially means `kind in (plan, execute)`.

## Heartbeats + stuck run handling

Executor updates `runs.heartbeat_at` periodically while a run is `running`.

Scheduler will (future):
- detect `running` runs with no heartbeat within a threshold
- mark them `failed` or `retry_wait`
- release any repo locks

## PR-only publishing

Publishing must be enforced by code and GitHub settings:

- Code: publishing step refuses pushes to `main|master`
- GitHub: branch protections on `main|master`

## Coder↔Reviewer loop (future)

Introduce run kinds and loop index:

- kinds: `plan`, `execute`, `review`, `publish`
- `loop_index` increments for execute/review cycles
- stop when reviewer verdict `pass` or `loop_index == 3`

Reviewer emits a structured artifact:

```json
{
  "verdict": "pass" | "changes_requested" | "unsafe" | "unclear",
  "must_fix": ["..."],
  "suggestions": ["..."],
  "notes": "..."
}
```

Scheduler reads this and enqueues the next run.

## What’s implemented so far

- DB migration adds:
  - `claimed_by`, `claimed_at`
  - `heartbeat_at`
  - `attempt_count`, `next_eligible_at`
  - `priority`, `loop_index`
  - new statuses: `claimed`, `retry_wait`, `cancelling`

- A basic scheduler loop (`apps/worker/src/scheduler.ts`):
  - leader election via `pg_try_advisory_lock`
  - claims queued runs up to global limit
  - simple per-project mutation guard

- Worker now:
  - prefers `claimed` runs first
  - sets `heartbeat_at` on claim
  - heartbeats while running
  - supports `OC_DASH_MODE=scheduler` to run the scheduler process

## Next steps

1. Add stuck-run reaper logic in scheduler
2. Make executor only pick up runs claimed for it (or introduce `claimed_by=worker_id` vs `claimed_by=scheduler_id`)
3. Add repo-level lock table (per repo checkout), not just per-project
4. Introduce review/publish kinds and loop state machine
5. Add strict PR-only enforcement in `ensurePushedOrPr` (block main/master)
