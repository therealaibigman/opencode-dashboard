import { NextResponse } from 'next/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { makeDb } from '@ocdash/db/client';
import { artifacts, runs } from '@ocdash/db/schema';
import { newId } from '@ocdash/shared';
import { appendProjectEvent } from '../../../_lib/eventlog';

export const runtime = 'nodejs';

const WORKSPACES_ROOT = process.env.PROJECT_WORKSPACES_ROOT ?? '/home/exedev/.openclaw/workspace/opencode-workspaces';

function policyAllowCommand(cmd: string): { ok: true } | { ok: false; reason: string } {
  const s = cmd.trim();
  const block = [
    /\brm\s+-rf\b/i,
    /\brm\s+-fr\b/i,
    /\bmkfs\b/i,
    /\bdd\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bsudo\b/i,
    /\bcurl\b[^\n]*\|\s*sh\b/i,
    /\bwget\b[^\n]*\|\s*sh\b/i
  ];
  if (!s) return { ok: false, reason: 'empty command' };
  if (block.some((re) => re.test(s))) return { ok: false, reason: 'blocked command pattern' };

  const allow = [
    /^git\s+apply\s+.+$/,
    /^git\s+add\s+-A$/,
    /^git\s+commit\s+-m\s+.+$/,
    /^npm\s+test$/,
    /^npm\s+run\s+lint$/,
    /^npm\s+run\s+typecheck$/,
    /^npm\s+run\s+build$/
  ];
  if (!allow.some((re) => re.test(s))) return { ok: false, reason: 'command not on allowlist' };
  return { ok: true };
}

function extractTouchedPaths(patchText: string): string[] {
  const touched = new Set<string>();
  for (const ln of patchText.split('\n')) {
    const m = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m?.[2]) touched.add(m[2]);
  }
  return [...touched];
}

function ensureInWorkspace(ws: string, filePath: string) {
  const abs = path.resolve(ws, filePath);
  const root = path.resolve(ws);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return { ok: false as const, reason: `path escapes workspace: ${filePath}` };
  }
  return { ok: true as const };
}

async function runCmd(cwd: string, cmd: string, timeoutMs = 10 * 60 * 1000) {
  const dec = policyAllowCommand(cmd);
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
    const patchText = patchArtifact.contentText ?? '';
    if (!patchText.trim()) return NextResponse.json({ error: 'patch artifact is empty' }, { status: 400 });

    const ws = path.resolve(WORKSPACES_ROOT, r.projectId);

    // Hard stop: never allow patch touching outside workspace.
    const touched = extractTouchedPaths(patchText);
    for (const p of touched) {
      const dec = ensureInWorkspace(ws, p);
      if (!dec.ok) {
        return NextResponse.json({ error: dec.reason }, { status: 400 });
      }
    }

    // Mark running.
    await db
      .update(runs)
      .set({ status: 'running' })
      .where(and(eq(runs.id, rid), inArray(runs.status, ['needs_approval'])));

    const stepId = 'stp_manual_approval';

    // Apply patch
    const patchFile = path.join(ws, `.ocdash_manual_${Date.now()}.diff`);
    await fs.writeFile(patchFile, patchText, 'utf8');

    const applyRes = await runCmd(ws, `git apply ${patchFile}`);
    const applyOutId = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stdout', name: 'git apply stdout', content: applyRes.stdout });
    const applyErrId = await writeArtifact({ db, projectId: r.projectId, runId: rid, stepId, kind: 'stderr', name: 'git apply stderr', content: applyRes.stderr });

    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: rid,
      type: 'approval.resolved',
      severity: applyRes.exitCode === 0 ? 'info' : 'error',
      payload: { auto: false, approved: true, action: 'apply_patch', stdout_artifact_id: applyOutId, stderr_artifact_id: applyErrId }
    });

    if (applyRes.exitCode !== 0) {
      await db.update(runs).set({ status: 'failed', finishedAt: new Date() }).where(eq(runs.id, rid));
      return NextResponse.json({ ok: false, error: 'git apply failed' }, { status: 500 });
    }

    // checks
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

    await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(runs.id, rid));
    await appendProjectEvent({
      databaseUrl: url,
      projectId: r.projectId,
      taskId: r.taskId ?? null,
      runId: rid,
      type: 'run.completed',
      payload: { message: 'Run completed (manual approval applied patch + checks + commit)' }
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } finally {
    await pool.end();
  }
}
