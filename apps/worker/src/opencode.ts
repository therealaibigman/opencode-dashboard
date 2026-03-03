import { spawn } from 'node:child_process';

export type OpenCodeRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function opencodeRun({
  cwd,
  message,
  timeoutMs = 10 * 60 * 1000
}: {
  cwd: string;
  message: string;
  timeoutMs?: number;
}): Promise<OpenCodeRunResult> {
  return await new Promise((resolve) => {
    const child = spawn('opencode', ['run', message, '--print-logs', '--log-level', 'INFO'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    const t = setTimeout(() => {
      stderr += `\n[worker] timeout after ${timeoutMs}ms`;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

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
