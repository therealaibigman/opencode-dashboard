import { spawn } from 'node:child_process';

export type OpenCodeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function opencodeRun({
  cwd,
  message,
  timeoutMs = 10 * 60 * 1000,
  model,
  onStdout,
  onStderr
}: {
  cwd: string;
  message: string;
  timeoutMs?: number;
  model?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}): Promise<OpenCodeRunResult> {
  const stub = String(process.env.OPENCODE_STUB ?? '') === '1';
  if (stub) {
    const fake = [
      '[stub] opencode not configured; simulating a run',
      `[stub] cwd=${cwd}`,
      `[stub] model=${model ?? process.env.OPENCODE_MODEL ?? '(none)'}`,
      '[stub] doing work…',
      '[stub] done'
    ].join('\n');

    onStdout?.(fake + '\n');
    await new Promise((r) => setTimeout(r, 350));

    return { exitCode: 0, stdout: fake + '\n', stderr: '' };
  }

  return await new Promise((resolve) => {
    const m = (model ?? process.env.OPENCODE_MODEL ?? '').trim();

    const args = ['run', message, '--print-logs', '--log-level', 'INFO'];
    if (m) args.push('--model', m);

    const child = spawn('opencode', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const t = setTimeout(() => {
      const msg = `\n[worker] timeout after ${timeoutMs}ms`;
      stderr += msg;
      onStderr?.(msg);
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      onStdout?.(s);
    });

    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      onStderr?.(s);
    });

    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${String(err)}` });
    });
  });
}
