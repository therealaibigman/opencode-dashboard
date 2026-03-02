import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  index
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

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    projectIdx: index('tasks_project_idx').on(t.projectId),
    statusIdx: index('tasks_status_idx').on(t.status)
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
    status: runStatusEnum('status').notNull().default('queued'),
    modelProfile: text('model_profile').notNull().default('balanced'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (r) => ({
    projectIdx: index('runs_project_idx').on(r.projectId),
    statusIdx: index('runs_status_idx').on(r.status)
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

    // monotonic per run (or 0 for non-run events)
    seq: integer('seq').notNull().default(0),

    type: text('type').notNull(),
    source: text('source').notNull(),
    severity: text('severity').notNull().default('info'),
    correlationId: text('correlation_id'),
    payload: jsonb('payload').notNull().default({})
  },
  (e) => ({
    runSeqIdx: index('events_run_seq_idx').on(e.runId, e.seq),
    runTsIdx: index('events_run_ts_idx').on(e.runId, e.ts)
  })
);
