import { spawn } from 'child_process';

export type CmdResult = { exitCode: number; stdout: string; stderr: string };

export async function runCmdShell({
  cwd,
  cmd,
  timeoutMs = 10 * 60 * 1000
}: {
  cwd: string;
  cmd: string;
  timeoutMs?: number;
}): Promise<CmdResult> {
  return await new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const t = setTimeout(() => {
      stderr += `\n[cmd] timeout after ${timeoutMs}ms`;
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

export type CreatePrArgs = {
  ws: string;
  runId: string;
  baseBranch: string;
  title: string;
  body: string;
};

export type CreatePrResult =
  | {
      ok: true;
      url: string;
      branch: string;
      number?: number;
      repo?: string;
      state?: string;
    }
  | { ok: false; error: string };

async function enrichPr({
  ws,
  url
}: {
  ws: string;
  url: string;
}): Promise<{ number?: number; repo?: string; state?: string }> {
  const view = await runCmdShell({ cwd: ws, cmd: `gh pr view ${JSON.stringify(url)} --json number,state,repository,url` });
  if (view.exitCode !== 0) return {};

  try {
    const j = JSON.parse(view.stdout || '{}');
    return {
      number: typeof j.number === 'number' ? j.number : undefined,
      state: typeof j.state === 'string' ? j.state : undefined,
      repo: typeof j.repository?.nameWithOwner === 'string' ? j.repository.nameWithOwner : undefined
    };
  } catch {
    return {};
  }
}

export async function createGithubPr({
  ws,
  runId,
  baseBranch,
  title,
  body
}: CreatePrArgs): Promise<CreatePrResult> {
  const branch = `ocdash/run_${runId}`;

  // If PR already exists for this head branch, reuse it.
  const existing = await runCmdShell({
    cwd: ws,
    cmd: `gh pr list --head ${branch} --state open --json url,number --limit 1`
  });

  if (existing.exitCode === 0) {
    try {
      const arr = JSON.parse(existing.stdout || '[]');
      if (Array.isArray(arr) && arr[0]?.url) {
        const url = String(arr[0].url);
        const extra = await enrichPr({ ws, url });
        return { ok: true, url, branch, number: typeof arr[0].number === 'number' ? arr[0].number : extra.number, ...extra };
      }
    } catch {
      // ignore
    }
  }

  // Create/update branch at current HEAD
  const b = await runCmdShell({ cwd: ws, cmd: `git checkout -B ${branch}` });
  if (b.exitCode !== 0) return { ok: false, error: b.stderr || b.stdout || 'git checkout failed' };

  const push = await runCmdShell({ cwd: ws, cmd: `git push -u origin ${branch}` });
  if (push.exitCode !== 0) return { ok: false, error: push.stderr || push.stdout || 'git push failed' };

  const pr = await runCmdShell({
    cwd: ws,
    cmd: `gh pr create --base ${baseBranch} --head ${branch} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`
  });

  if (pr.exitCode !== 0) {
    // Maybe it actually exists now; try to discover.
    const again = await runCmdShell({ cwd: ws, cmd: `gh pr list --head ${branch} --state open --json url,number --limit 1` });
    if (again.exitCode === 0) {
      try {
        const arr = JSON.parse(again.stdout || '[]');
        if (Array.isArray(arr) && arr[0]?.url) {
          const url = String(arr[0].url);
          const extra = await enrichPr({ ws, url });
          return { ok: true, url, branch, number: typeof arr[0].number === 'number' ? arr[0].number : extra.number, ...extra };
        }
      } catch {
        // ignore
      }
    }

    return { ok: false, error: pr.stderr || pr.stdout || 'gh pr create failed' };
  }

  const url = (pr.stdout.trim().split(/\s+/).find((x) => x.startsWith('http')) ?? '').trim();
  if (!url) return { ok: false, error: `PR created but URL not detected: ${pr.stdout.trim()}` };

  const extra = await enrichPr({ ws, url });
  return { ok: true, url, branch, ...extra };
}
