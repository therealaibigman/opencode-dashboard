import { spawn } from 'node:child_process';

export type OpenCodeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  cancelled?: boolean;
};

export async function opencodeRun({
  cwd,
  message,
  timeoutMs = 10 * 60 * 1000,
  model,
  onStdout,
  onStderr,
  signal
}: {
  cwd: string;
  message: string;
  timeoutMs?: number;
  model?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<OpenCodeRunResult> {
  if (signal?.aborted) {
    return { exitCode: 137, stdout: '', stderr: '[worker] cancelled (pre-start)', cancelled: true };
  }

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

    // Allow cancellation even in stub mode.
    const start = Date.now();
    while (Date.now() - start < 350) {
      if (signal?.aborted) {
        return { exitCode: 137, stdout: fake + '\n', stderr: '[worker] cancelled (stub)', cancelled: true };
      }
      await new Promise((r) => setTimeout(r, 25));
    }

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
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      const msg = '\n[worker] cancelled';
      stderr += msg;
      onStderr?.(msg);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

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

    const finish = (exitCode: number) => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, cancelled: cancelled || signal?.aborted || false });
    };

    child.on('close', (code) => {
      finish(code ?? 1);
    });

    child.on('error', (err) => {
      stderr = `${stderr}\n${String(err)}`;
      finish(1);
    });
  });
}
