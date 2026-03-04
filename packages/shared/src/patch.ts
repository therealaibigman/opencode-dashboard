import fs from 'fs/promises';
import path from 'path';

export type PatchExtract = {
  patchText: string;
  touchedPaths: string[];
  hasGitHeaders: boolean;
};

// Extract the first ```diff ...``` fenced block.
export function extractUnifiedDiffFromText(text: string): PatchExtract | null {
  const m = text.match(/```diff\s*([\s\S]*?)```/m);
  if (!m) return null;
  const raw = m[1]!.trim();
  const patchText = raw + (raw.endsWith('\n') ? '' : '\n');

  const touchedPaths = new Set<string>();
  const lines = patchText.split('\n');
  let hasGitHeaders = false;

  for (const ln of lines) {
    const mm = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (mm?.[2]) {
      hasGitHeaders = true;
      touchedPaths.add(mm[2]);
    }
  }

  return { patchText, touchedPaths: [...touchedPaths], hasGitHeaders };
}

export function extractTouchedPaths(patchText: string): string[] {
  const touched = new Set<string>();
  for (const ln of patchText.split('\n')) {
    const m = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m?.[2]) touched.add(m[2]);
  }
  return [...touched];
}

export function wrapHunkAsFilePatch({ patchText, filePath }: { patchText: string; filePath: string }) {
  const hunks = patchText.trimEnd();
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    hunks,
    ''
  ].join('\n');
}

export async function writeTempPatch({ dir, patchText }: { dir: string; patchText: string }) {
  const p = path.join(dir, `.ocdash_patch_${Date.now()}_${Math.random().toString(16).slice(2)}.diff`);
  await fs.writeFile(p, patchText, 'utf8');
  return p;
}

export function extractAddedLines(patchText: string): string[] {
  const added: string[] = [];
  for (const ln of patchText.split('\n')) {
    if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('diff --git') || ln.startsWith('@@')) continue;
    if (ln.startsWith('+') && !ln.startsWith('+++')) added.push(ln.slice(1));
  }
  return added.filter((s) => s.trim().length > 0);
}
