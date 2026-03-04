# OpenCode Dashboard (ocdash)

A local-first control plane for running `opencode run` against real project workspaces.

This is not a chatbot toy. It’s a pipeline runner with receipts:

- Projects (local path mirror or git repo clone)
- Tasks (Kanban, DB-backed ordering, archive/restore)
- Runs (plan/execute, events timeline, artifacts)
- Approval gates (diff-based, allowlist-first)
- Publish (PR for existing repos, direct push for bootstrap repos)
- Threads + Messages (DB-backed chat history tied to runs/tasks)

Deployed basePath: **`/ocdash`**

---

## What it does

### Core workflow

1) Create a task (Chat or Kanban)
2) Run **Plan** → produces a JSON plan artifact → requires approval
3) Approve plan → queues an **Execute** run linked to the plan
4) Execute run may:
   - do nothing
   - generate a unified diff (patch artifact)
   - auto-apply + checks + commit + publish (if allowed)
   - or stop at **needs_approval**

### Run safety

Execute runs parse fenced diffs:

```diff
... unified diff ...
```

- If policy allows and approvals aren’t required, worker auto-applies.
- Otherwise it stops at `needs_approval` and you approve/reject.

---

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

### Run dev

```bash
npm run dev
# web: http://localhost:3000/ocdash
```

### Run worker

In a second terminal:

```bash
npm run worker
```

---

## Configuration (.env)

Key variables:

- `DATABASE_URL` (required)
- `WORKER_POLL_INTERVAL_MS` (worker poll interval)
- `PROJECT_WORKSPACES_ROOT` (default: `~/.openclaw/workspace/opencode-workspaces`)

OpenCode:

- `OPENCODE_MODEL` (optional)
- `OPENCODE_TIMEOUT_MS` (optional)
- `OPENCODE_STUB=1` to run without calling real opencode

Safety / approvals:

- `OC_DASH_REQUIRE_APPROVAL=1` forces execute diffs to require approval
- `OC_DASH_AUTO_COMMANDS="npm test,npm run lint,npm run typecheck"`

Worker identity:

- `OC_DASH_WORKER_ID=worker-1` (optional)

---

## UI Settings

Settings tab is **local** (stored in browser localStorage):

- Theme toggle (dark/light)
- Model profile default (passed as `model_profile` when queueing runs)
- YOLO mode (UI flag only; real safety is enforced by server env)

---

## Deployment

### systemd (example)

- `infra/systemd/ocdash-web.service`
- `infra/systemd/ocdash-worker.service`

### nginx (example)

- `infra/nginx/ocdash.conf`

### Health

- `/ocdash/api/health` gives DB + opencode + gh status.

---

## Dev rules (GSD vibe)

- Keep basePath bugs dead: **never hardcode `/ocdash` into router.push**.
- Prefer receipts over vibes: events + artifacts over hidden state.
- If it’s destructive, it needs an approval gate.
