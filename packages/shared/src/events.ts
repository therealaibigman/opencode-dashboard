export type EventSeverity = 'debug' | 'info' | 'warn' | 'error';

export type EventSource = 'ui' | 'api' | 'worker' | 'opencode' | 'tool';

export type EventType =
  | 'chat.message.created'
  | 'chat.action.requested'
  | 'task.created'
  | 'task.updated'
  | 'task.status.changed'
  | 'run.created'
  | 'run.started'
  | 'run.status.changed'
  | 'run.needs_approval'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.step.started'
  | 'run.step.progress'
  | 'run.step.completed'
  | 'run.step.failed'
  | 'tool.call.requested'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'llm.requested'
  | 'llm.responded'
  | 'approval.requested'
  | 'approval.resolved'
  | 'artifact.created';

export type OcdashEvent<TPayload = unknown> = {
  id: string;
  ts: string; // ISO
  seq: number; // monotonic per-run
  type: EventType;
  source: EventSource;
  severity: EventSeverity;

  project_id?: string;
  task_id?: string;
  thread_id?: string;
  run_id?: string;
  step_id?: string;

  correlation_id?: string;
  payload: TPayload;
};

export function toSse({ event }: { event: OcdashEvent }): string {
  // SSE: id is the sequence number for resume
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
