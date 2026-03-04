import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';

export type ProjectSource = {
  id: string;
  localPath?: string | null;
  repoUrl?: string | null;
  defaultBranch?: string | null;
};

const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.cache',
  '.DS_Store',
  'coverage',
  '.venv',
  '__pycache__'
];

async function runGit({ cwd, args }: { cwd?: string; args: string[] }) {
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('git', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${String(err)}` }));
  });
}

async function pathExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function shouldExclude(rel: string) {
  const parts = rel.split(path.sep);
  return parts.some((p) => DEFAULT_EXCLUDES.includes(p));
}

async function mirrorDir({ src, dest }: { src: string; dest: string }) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });

  await fs.cp(src, dest, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = path.relative(src, source);
      if (!rel || rel === '.') return true;
      return !shouldExclude(rel);
    }
  });
}

export async function ensureProjectWorkspace({ root, projectId }: { root: string; projectId: string }): Promise<string> {
  const dir = path.resolve(root, projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureOriginRemote({ workspace, repoUrl }: { workspace: string; repoUrl: string }) {
  const rem = await runGit({ cwd: workspace, args: ['remote'] });
  if (rem.exitCode !== 0) return;
  const remotes = rem.stdout.split(/\s+/).map((x) => x.trim()).filter(Boolean);

  if (!remotes.includes('origin')) {
    await runGit({ cwd: workspace, args: ['remote', 'add', 'origin', repoUrl] });
  } else {
    // Keep origin in sync with configured repo URL.
    await runGit({ cwd: workspace, args: ['remote', 'set-url', 'origin', repoUrl] });
  }
}

export async function prepareWorkspaceForProject({
  root,
  project
}: {
  root: string;
  project: ProjectSource;
}): Promise<{ workspace: string; mode: 'scratch' | 'mirror' | 'clone' }>{
  const workspace = await ensureProjectWorkspace({ root, projectId: project.id });

  // Prefer localPath if both are set.
  const localPath = (project.localPath ?? '').trim();
  const repoUrl = (project.repoUrl ?? '').trim();
  const branch = (project.defaultBranch ?? '').trim() || 'main';

  if (localPath) {
    const abs = path.resolve(localPath);
    if (!(await pathExists(abs))) {
      throw new Error(`local_path does not exist: ${abs}`);
    }

    await mirrorDir({ src: abs, dest: workspace });
    return { workspace, mode: 'mirror' };
  }

  if (repoUrl) {
    const gitDir = path.join(workspace, '.git');
    if (!(await pathExists(gitDir))) {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.mkdir(path.dirname(workspace), { recursive: true });
      const res = await runGit({ args: ['clone', '--depth', '1', '--branch', branch, repoUrl, workspace] });
      if (res.exitCode !== 0) throw new Error(`git clone failed: ${res.stderr || res.stdout}`);
    } else {
      await ensureOriginRemote({ workspace, repoUrl });

      const fetch = await runGit({ cwd: workspace, args: ['fetch', '--all', '--prune'] });
      if (fetch.exitCode !== 0) throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`);

      const checkout = await runGit({ cwd: workspace, args: ['checkout', branch] });
      if (checkout.exitCode !== 0) {
        await runGit({ cwd: workspace, args: ['checkout', '-B', branch, `origin/${branch}`] });
      }

      await runGit({ cwd: workspace, args: ['pull', '--ff-only'] });
    }

    // Always ensure origin is correctly set (covers clone + later updates).
    await ensureOriginRemote({ workspace, repoUrl });

    return { workspace, mode: 'clone' };
  }

  return { workspace, mode: 'scratch' };
}
