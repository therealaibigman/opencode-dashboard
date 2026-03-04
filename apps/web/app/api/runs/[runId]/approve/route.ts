import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { makeDb } from '@ocdash/db/client';
import { artifacts, projects, runs } from '@ocdash/db/schema';
import {
  extractAddedLines,
  extractTouchedPaths,
  policyCheckCommand,
  policyCheckPath,
  wrapHunkAsFilePatch,
  createGithubPr
} from '@ocdash/shared';
import { newId } from '@ocdash/shared';
import { appendProjectEvent } from '../../../_lib/eventlog';

export const runtime = 'nodejs';

const WORKSPACES_ROOT =
  process.env.PROJECT_WORKSPACES_ROOT ?? '/home/exedev/.openclaw/workspace/opencode-workspaces';

async function runCmd(cwd: string, cmd: string, timeoutMs = 10 * 60 * 1000) {
  const dec = policyCheckCommand(cmd);
  if (!dec.ok) return { exitCode: 126, stdout: '', stderr: `[policy] ${dec.reason}` };

  const [bin, ...args] = cmd.split(/\s+/);
  return await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(bin!, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const t = setTimeout(() => {
      stderr += `\n[api] timeout after ${timeoutMs}ms`;
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

async function writeArtifact({
  db,
  projectId,
  runId,
  stepId,
  kind,
  name,
  content
}: {
  db: any;
  projectId: string;
  runId: string;
  stepId: string;
  kind: string;
  name: string;
  content: string;
}) {
  const id = newId('art');
  await db.insert(artifacts).values({
    id,
    projectId,
    runId,
    stepId,
    kind,
    name,
    contentText: content
  });
  return id;
}

async function ensureGitRepo(ws: string) {
  await runCmd(ws, 'git init');
  await runCmd(ws, 'git config user.email ocdash@local');
  await runCmd(ws, 'git config user.name ocdash');
}

async function fileExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 });

  const rid = (runId ?? '').trim();
  if (!rid) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

  const { db, pool } = makeDb(url);
  try {
    const rrows = await db.select().from(runs).where(eq(runs.id, rid)).limit(1);
    if (!rrows.length) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const r = rrows[0]!;

    const projRows = await db.select().from(projects).where(eq(projects.id, r.projectId)).limit(1);
    const proj = projRows[0];
    const baseBranch = String((proj as any)?.defaultBranch ?? 'main') || 'main';
    if (r.status !== 'needs_approval') {
      return NextResponse.json({ error: `run is not in needs_approval (status=${r.status})` }, { status: 400 });
    }

    // Find latest patch artifact.
    const arows = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, rid), eq(artifacts.kind, 'patch')))
      .orderBy(desc(artifacts.createdAt))
      .limit(1);

    if (!arows.length) return NextResponse.json({ error: 'no patch artifact found for run' }, { status: 400 });

    const patchArtifact = arows[0]!;
    let patchText = patchArtifact.contentText ?? '';
    if (!patchText.trim()) return NextResponse.json({ error: 'patch artifact is empty' }, { status: 400 });

    const ws = path.resolve(WORKSPACES_ROOT, r.projectId);
    await ensureGitRepo(ws);

    // If patch is just a hunk, assume README.md for testing.
    if (!/^diff --git\s+/m.test(patchText) && patchText.trimStart().startsWith('@@')) {
      patchText = wrapHunkAsFilePatch({ patchText, filePath: 'README.md' });
    }

    // Hard stop: never allow patch touching outside workspace.
    const touched = extractTouchedPaths(patchText);
    for (const p of touched) {
      const dec = policyCheckPath({ workspace: ws, filePath: p });
      if (!dec.ok) return NextResponse.json({ error: dec.reason }, { status: 400 });
    }

    // Mark running.
    await db.update(runs).set({ status: 'running' }).where(and(eq(runs.id, rid), inArray(runs.status, ['needs_approval'])));

    const stepId = 'stp_manual_approval';

    // Apply patch
    const patchFile = path.join(ws, `.ocdash_manual_${Date.now()}.diff`);
    await fs.writeFile(patchFile, patchText, 'utf8');

    let applyRes = await runCmd(ws, `git apply ${patchFile}`);
    let method = 'git apply';

    if (applyRes.exitCode !== 0) {
      const p = await runCmd(ws, `patch -p1 --forward --batch -i ${patchFile}`);
      method = 'patch -p1';
      applyRes = {
        exitCode: p.exitCode,
        stdout: `${applyRes.stdout}\n---\n[fallback patch stdout]\n${p.stdout}`,
        stderr: `${applyRes.stderr}\n---\n[fallback patch stderr]\n${p.stderr}`
      };
    }

    if (applyRes.exitCode !== 0 && touched.length === 1 && touched[0] === 'README.md') {
      const added = extractAddedLines(patchText);
      const readmePath = path.join(ws, 'README.md');
      const cur = await fs.readFile(readmePath, 'utf8').catch(() => '');

      let next = cur;
      for (const line of added) {
        if (!next.includes(line)) {
          next = next.replace(/\s*$/, '') + `\n${line}\n`;
        }
      }

      await fs.writeFile(readmePath, next, 'utf8');
      method = 'manual-append-readme';
      applyRes = { exitCode: 0, stdout: `[api] applied README.md changes by appending ${added.length} line(s)`, stderr: '' };
    }

    const applyOutId = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stdout', name: `apply patch stdout (${method})`, content: applyRes.stdout });
    const applyErrId = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stderr', name: `apply patch stderr (${method})`, content: applyRes.stderr });

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: rid,
      type: 'approval.resolved',
      severity: applyRes.exitCode === 0 ? 'info' : 'error',
      payload: { auto: false, approved: true, action: 'apply_patch', method, stdout_artifact_id: applyOutId, stderr_artifact_id: applyErrId }
    });

    if (applyRes.exitCode !== 0) {
      await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, rid));
      return NextResponse.json({ ok: false, error: 'apply patch failed', stderr_artifact_id: applyErrId }, { status: 500 });
    }

    // checks (skip if no package.json)
    const hasPkg = await fileExists(path.join(ws, 'package.json'));
    if (!hasPkg) {
      const skipId = await writeArtifact({
        db,
        projectId: r.projectId,
        runId: rid,
        stepId,
        kind: 'stdout',
        name: 'checks skipped',
        content: '[api] No package.json in workspace; skipping npm checks'
      });

      await appendProjectEvent({
        databaseUrl: url,
        projectId: r.projectId,
        taskId: r.taskId ?? null,
        runId: rid,
        type: 'run.step.progress',
        payload: { message: 'No package.json in workspace; skipping npm checks', artifact_id: skipId }
      });
    } else {
      const cmds = ['npm test', 'npm run lint', 'npm run typecheck'];
      for (const cmd of cmds) {
        const res = await runCmd(ws, cmd);
        const outId = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stdout', name: `${cmd} stdout`, content: res.stdout });
        const errId = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stderr', name: `${cmd} stderr`, content: res.stderr });
        if (res.exitCode !== 0) {
          await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, rid));
          return NextResponse.json({ ok: false, error: `${cmd} failed`, stdout_artifact_id: outId, stderr_artifact_id: errId }, { status: 500 });
        }
      }
    }

    // commit
    await runCmd(ws, 'git add -A');
    const commitMsg = `ocdash: approve patch for ${r.taskId ?? rid}`;
    const commitRes = await runCmd(ws, `git commit -m "${commitMsg.replace(/"/g, "'")}"`);
    const cOut = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stdout', name: 'git commit stdout', content: commitRes.stdout });
    const cErr = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stderr', name: 'git commit stderr', content: commitRes.stderr });

    if (commitRes.exitCode !== 0) {
      await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, rid));
      return NextResponse.json({ ok: false, error: 'git commit failed', stdout_artifact_id: cOut, stderr_artifact_id: cErr }, { status: 500 });
    }

    // Optional: create a GitHub PR (requires origin remote + gh auth).
    const prTitle = `ocdash: ${r.taskId ?? rid}`;
    const prBody = `Automated changes from OpenCode Dashboard.\n\nRun: ${rid}\nProject: ${r.projectId}\nTask: ${r.taskId ?? '(none)'}\n`;

    const prRes = await createGithubPr({ ws, runId: rid, baseBranch, title: prTitle, body: prBody });

    if (prRes.ok) {
      await db.update(runs).set({ prUrl: prRes.url, prBranch: prRes.branch }).where(eq(runs.id, rid));
      const prArtId = await writeArtifact({
        db,
        projectId: r.projectId,
        runId: rid,
        stepId,
        kind: 'github_pr',
        name: 'GitHub PR',
        content: prRes.url + '\n'
      });

      await appendProjectEvent({
        databaseUrl: url,
        projectId: r.projectId,
        taskId: r.taskId ?? null,
        runId: rid,
        type: 'tool.call.completed',
        payload: { tool: 'github.pr.create', url: prRes.url, artifact_id: prArtId }
      });
    } else {
      const prErrId = await writeArtifact({
        db,
        projectId: r.projectId,
        runId: rid,
        stepId,
        kind: 'stderr',
        name: 'github pr create failed',
        content: String(prRes.error)
      });

      await appendProjectEvent({
        databaseUrl: url,
        projectId: r.projectId,
        taskId: r.taskId ?? null,
        runId: rid,
        type: 'tool.call.failed',
        severity: 'warn',
        payload: { tool: 'github.pr.create', error: prRes.error, stderr_artifact_id: prErrId }
      });
    }

    await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(runs.id, rid));
    await appendProjectEvent({ databaseUrl: url, projectId: r.projectId, taskId: r.taskId ?? null, runId: rid, type: 'run.completed', payload: { message: 'Run completed (manual approval applied patch + checks + commit)' } });

    return NextResponse.json({ ok: true }, { status: 200 });
  } finally {
    await pool.end();
  }
}
