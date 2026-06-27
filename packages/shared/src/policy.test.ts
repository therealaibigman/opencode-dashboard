import { describe, expect, it } from 'vitest';
import { policyCheckCommand, policyCheckPath } from './policy';

describe('policyCheckCommand', () => {
  it('allows explicitly allowlisted commands', () => {
    expect(policyCheckCommand('npm test')).toEqual({ ok: true, code: 'ok' });
  });

  it('blocks dangerous command patterns before allowlist checks', () => {
    expect(policyCheckCommand('rm -rf /tmp/work')).toMatchObject({
      ok: false,
      code: 'blocked_pattern',
    });
  });

  it('rejects commands outside the allowlist', () => {
    expect(policyCheckCommand('node script.js')).toEqual({
      ok: false,
      code: 'not_allowlisted',
      reason: 'command not on allowlist',
    });
  });
});

describe('policyCheckPath', () => {
  it('allows paths inside the workspace', () => {
    expect(policyCheckPath({ workspace: '/tmp/ws', filePath: 'src/index.ts' })).toEqual({ ok: true, code: 'ok' });
  });

  it('blocks paths escaping the workspace', () => {
    expect(policyCheckPath({ workspace: '/tmp/ws', filePath: '../secret.txt' })).toMatchObject({
      ok: false,
      code: 'path_escape',
    });
  });
});
