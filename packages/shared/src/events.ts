export type EventType =
  // project
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'

  // tasks
  | 'task.created'
  | 'task.updated'
  | 'task.status.changed'
  | 'task.archived.changed'

  // threads/messages
  | 'thread.created'
  | 'thread.updated'
  | 'message.created'

  // runs
  | 'run.created'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.step.started'
  | 'run.step.progress'
  | 'run.step.completed'
  | 'run.step.failed'

  // tools
  | 'tool.call.requested'
  | 'tool.call.completed'
  | 'tool.call.failed'

  // approvals
  | 'approval.requested'
  | 'approval.resolved'


  // ralph loop
  | 'ralph.resume'
  | 'ralph.max_loops_reached'

  // artifacts
  | 'artifact.created';

export type EventSeverity = 'debug' | 'info' | 'warn' | 'error';

// Event "source" is not currently a strict enum; keep it open.
export type EventSource = string;

export type OcdashEvent = {
  id: string;
  ts: string;

  // monotonic per run
  seq: number;

  type: EventType;
  source: EventSource;
  severity: EventSeverity;

  project_id?: string;
  task_id?: string;
  thread_id?: string;
  run_id?: string;
  step_id?: string;
  correlation_id?: string;

  payload?: any;
};

export function toSse(e: OcdashEvent) {
  const data = JSON.stringify(e);
  return `id: ${e.seq}\nevent: ${e.type}\ndata: ${data}\n\n`;
}
