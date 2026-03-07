# memory.md — Authoritative Orchestrator State (Symphony-style)

Date: 2026-03-07
Context: ocdash as a “control center of AI-driven development”.

## Summary

Symphony’s spec emphasizes **one authoritative orchestrator** that owns dispatch, retries, reconciliation, and concurrency.

ocdash today is a **DB-backed UI + worker** (Plan → Approve → Execute) with receipts (events + artifacts), and it can already be robust.

This note captures an optional future direction: make ocdash’s scheduling/dispatching semantics match the **Symphony orchestration model**, but implemented **DB-first** (since ocdash already uses Postgres).

## What was proposed

Implement an explicit orchestration layer inside ocdash:

- **Single “scheduler/dispatcher” leader** at any time.
  - Use `pg_advisory_lock` or a row lease to guarantee only one orchestrator loop is active.

- **Atomic run claiming** (DB state machine).
  - Scheduler transitions runs from `queued_*` → `running_*` and sets `claimed_by`, `claimed_at`.
  - Workers/executors only execute already-claimed runs.

- **Bounded concurrency**.
  - Enforce `max_active_runs_global`, `max_active_runs_per_project`, etc.

- **Retry + backoff as data**.
  - Store `attempt_count`, `next_eligible_at`, `last_error`.

- **Reconciliation / cancellation**.
  - On each tick (and on startup), stop/cancel runs that become ineligible (archived task, revoked approval, superseded plan, policy change, future: tracker state change).

- **Heartbeats + stuck-run reaper**.
  - If a run hasn’t heartbeated in N minutes, mark it `failed` / `retry_wait` and release it.

This mirrors Symphony’s “authoritative orchestrator state” idea, but using Postgres as the source of truth.

## Why this might be worth it

- Prevents duplicate execution when you scale workers.
- Clean restart recovery (no “what was running?” guessing).
- Enables pausing/throttling/canceling safely from the UI.
- Makes future tracker integrations (Linear/GitHub) cleaner: scheduler reconciles eligibility based on external state.

## Why you might *not* want it (possible misunderstanding check)

The intuition that “current implementation feels more efficient and robust” can be correct depending on scope:

- If you run **one worker**, in **one environment**, with **human-in-the-loop approvals**, a simpler loop can be more reliable in practice (less moving parts).
- A DB-orchestrator adds complexity: more states, more failure modes (locks/leases), more code to get wrong.
- Symphony’s model is designed for **many concurrent long-running jobs**, often **triggered automatically** from an issue tracker, where duplicates and reconciliation are real pain.

So: adopting Symphony-style orchestration is not automatically “better”. It’s a scaling/operability trade.

## Recommended incremental path (if revisited)

1. Add atomic “claim run” transition in DB (even with a single worker).
2. Add heartbeats and stuck-run detection.
3. Add concurrency limits.
4. Add leader election if/when multiple schedulers could exist.
5. Only then split “scheduler” vs “executor” processes if needed.

## Open questions

- Do we plan to run multiple workers concurrently?
- Do tasks originate only from humans, or will we add tracker-driven auto-dispatch?
- Is “exactly once” execution required, or is “at least once + safe idempotence” acceptable?
- Should workflow policy live in env (current) or in repo-owned contracts like `WORKFLOW.md` (Symphony-style)?

## Decision status

Not committed. Kept as a possible future direction.
