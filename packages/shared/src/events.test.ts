import { describe, expect, it } from 'vitest';
import { toSse, type OcdashEvent } from './events';

describe('toSse', () => {
  it('formats dashboard events as server-sent events', () => {
    const event: OcdashEvent = {
      id: 'evt_1',
      ts: '2026-01-01T00:00:00.000Z',
      seq: 7,
      type: 'run.started',
      source: 'worker',
      severity: 'info',
      payload: { runId: 'run_1' },
    };

    const sse = toSse(event);

    expect(sse).toContain('id: 7\n');
    expect(sse).toContain('event: run.started\n');
    expect(sse).toContain('"payload":{"runId":"run_1"}');
    expect(sse.endsWith('\n\n')).toBe(true);
  });
});
