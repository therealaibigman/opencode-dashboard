import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  index,
  doublePrecision
} from 'drizzle-orm/pg-core';

export const taskStatusEnum = pgEnum('task_status', [
  'inbox',
  'planned',
  'in_progress',
  'blocked',
  'review',
  'done'
]);

export const runStatusEnum = pgEnum('run_status', [
  'queued',
  'running',
  'needs_approval',
  'failed',
  'succeeded',
  'cancelled'
]);

export const runKindEnum = pgEnum('run_kind', ['execute', 'plan']);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),

  // Phase 4: real project sources
  localPath: text('local_path'),
  repoUrl: text('repo_url'),
  defaultBranch: text('default_branch'),

  // Model routing (optional overrides)
  planModel: text('plan_model'),
  executeModel: text('execute_model'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull().default(''),
    status: taskStatusEnum('status').notNull().default('inbox'),

    // Stable ordering inside a status column.
    // Uses float positions to allow cheap "insert between" during drag-drop.
    position: doublePrecision('position').notNull().default(0),

    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    projectIdx: index('tasks_project_idx').on(t.projectId),
    statusIdx: index('tasks_status_idx').on(t.status),
    archivedIdx: index('tasks_archived_idx').on(t.archivedAt),
    orderingIdx: index('tasks_ordering_idx').on(t.projectId, t.status, t.position)
  })
);

export const threads = pgTable(
  'threads',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    projectIdx: index('threads_project_idx').on(t.projectId),
    taskIdx: index('threads_task_idx').on(t.taskId),
    updatedIdx: index('threads_updated_idx').on(t.projectId, t.updatedAt)
  })
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant | system
    contentMd: text('content_md').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (m) => ({
    threadIdx: index('messages_thread_idx').on(m.threadId, m.createdAt),
    projectIdx: index('messages_project_idx').on(m.projectId, m.createdAt)
  })
);

export const pipelines = pgTable(
  'pipelines',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull().default('v1'),
    graphJson: jsonb('graph_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (p) => ({
    nameIdx: index('pipelines_name_idx').on(p.name)
  })
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),

    // For plan → execute linking.
    parentRunId: text('parent_run_id'),

    // Link to a discussion thread.
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),

    // Optional pipeline template used to execute this run.
    pipelineId: text('pipeline_id').references(() => pipelines.id, { onDelete: 'set null' }),

    kind: runKindEnum('kind').notNull().default('execute'),

    status: runStatusEnum('status').notNull().default('queued'),
    modelProfile: text('model_profile').notNull().default('balanced'),

    // Which worker claimed/executed the run (useful for debugging multi-worker setups)
    workerId: text('worker_id'),

    // GitHub integration: persisted PR info (optional)
    prUrl: text('pr_url'),
    prBranch: text('pr_branch'),
    prNumber: integer('pr_number'),
    prRepo: text('pr_repo'),
    prState: text('pr_state'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (r) => ({
    projectIdx: index('runs_project_idx').on(r.projectId),
    statusIdx: index('runs_status_idx').on(r.status),
    kindIdx: index('runs_kind_idx').on(r.kind),
    parentIdx: index('runs_parent_idx').on(r.parentRunId),
    threadIdx: index('runs_thread_idx').on(r.threadId),
    pipelineIdx: index('runs_pipeline_idx').on(r.pipelineId)
  })
);
export const runSteps = pgTable(
  'run_steps',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: text('status').notNull().default('queued'),
    model: text('model'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    inputJson: jsonb('input_json').notNull().default({}),
    outputJson: jsonb('output_json').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (s) => ({
    runIdx: index('run_steps_run_idx').on(s.runId, s.createdAt),
    projectIdx: index('run_steps_project_idx').on(s.projectId, s.createdAt)
  })
);


export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    stepId: text('step_id'),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    contentText: text('content_text').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (a) => ({
    runIdx: index('artifacts_run_idx').on(a.runId),
    projectIdx: index('artifacts_project_idx').on(a.projectId)
  })
);

export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),

    projectId: text('project_id'),
    taskId: text('task_id'),
    threadId: text('thread_id'),
    runId: text('run_id'),
    stepId: text('step_id'),

    seq: integer('seq').notNull().default(0),

    type: text('type').notNull(),
    source: text('source').notNull(),
    severity: text('severity').notNull().default('info'),
    correlationId: text('correlation_id'),
    payload: jsonb('payload').notNull().default({})
  },
  (e) => ({
    runSeqIdx: index('events_run_seq_idx').on(e.runId, e.seq),
    runTsIdx: index('events_run_ts_idx').on(e.runId, e.ts),
    projectTsIdx: index('events_project_ts_idx').on(e.projectId, e.ts)
  })
);
