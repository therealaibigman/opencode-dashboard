import path from 'node:path';

export type PolicyDecision =
  | { ok: true }
  | { ok: false; reason: string };

// Hard blocks: obvious footguns.
const BLOCK_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\brm\s+-fr\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bsudo\b/i,
  /\bcurl\b[^\n]*\|\s*sh\b/i,
  /\bwget\b[^\n]*\|\s*sh\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
];

// Block writes outside workspace or into sensitive system areas.
const BLOCK_PATHS: RegExp[] = [
  /^\/etc\b/i,
  /^\/var\b/i,
  /^\/usr\b/i,
  /^\/bin\b/i,
  /^\/sbin\b/i,
  /^\/lib\b/i,
  /^\/lib64\b/i,
  /^\/proc\b/i,
  /^\/sys\b/i,
  /^\/dev\b/i,
  /^\/root\b/i,
  /\/\.ssh\b/i,
  /\/systemd\b/i,
  /crontab/i
];

// Tight allowlist. Expand cautiously.
const ALLOW_COMMANDS: RegExp[] = [
  /^git\s+init$/,
  /^git\s+config\s+user\.email\s+.+$/,
  /^git\s+config\s+user\.name\s+.+$/,
  /^git\s+apply(\s+.*)?$/,
  /^git\s+add\s+-A$/,
  /^git\s+commit\s+-m\s+.+$/,
  /^git\s+status(\s+.*)?$/,
  /^git\s+diff(\s+.*)?$/,
  /^git\s+log\s+-n\s+\d+$/,
  /^npm\s+test$/,
  /^npm\s+run\s+lint$/,
  /^npm\s+run\s+typecheck$/,
  /^npm\s+run\s+build$/,
  /^patch\s+-p1(\s+.*)?$/
];

export function policyCheckCommand(cmd: string): PolicyDecision {
  const s = cmd.trim();
  if (!s) return { ok: false, reason: 'empty command' };

  for (const re of BLOCK_PATTERNS) {
    if (re.test(s)) return { ok: false, reason: `blocked pattern: ${re}` };
  }

  if (!ALLOW_COMMANDS.some((re) => re.test(s))) {
    return { ok: false, reason: 'command not on allowlist' };
  }

  return { ok: true };
}

export function policyCheckPath({ workspace, filePath }: { workspace: string; filePath: string }): PolicyDecision {
  const abs = path.resolve(workspace, filePath);
  const ws = path.resolve(workspace);

  if (!abs.startsWith(ws + path.sep) && abs !== ws) {
    return { ok: false, reason: `path escapes workspace: ${filePath}` };
  }

  for (const re of BLOCK_PATHS) {
    if (re.test(abs)) return { ok: false, reason: `blocked path: ${abs}` };
  }

  return { ok: true };
}
