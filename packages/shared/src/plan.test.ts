import { describe, expect, it } from 'vitest';
import { validatePlanJson } from './plan';

describe('validatePlanJson', () => {
  it('normalizes a valid plan payload', () => {
    const result = validatePlanJson(
      JSON.stringify({
        summary: 'Ship it',
        steps: [{ title: 'Test', details: 'Run checks', risk: 'low' }],
        files: ['src/index.ts'],
        commands: ['npm test'],
      }),
    );

    expect(result).toEqual({
      ok: true,
      plan: {
        summary: 'Ship it',
        steps: [{ title: 'Test', details: 'Run checks', risk: 'low' }],
        files: ['src/index.ts'],
        commands: ['npm test'],
      },
    });
  });

  it('rejects malformed JSON and missing steps', () => {
    expect(validatePlanJson('{')).toMatchObject({ ok: false });
    expect(validatePlanJson(JSON.stringify({ summary: 'No steps' }))).toEqual({
      ok: false,
      error: 'plan.steps must be an array',
    });
  });
});
