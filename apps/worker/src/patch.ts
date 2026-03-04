import fs from 'node:fs/promises';
import path from 'node:path';

export type PatchExtract = {
  patchText: string;
  touchedPaths: string[];
  hasGitHeaders: boolean;
};

// Very simple extractor: grabs the first ```diff ...``` fenced block.
export function extractUnifiedDiffFromText(text: string): PatchExtract | null {
  const m = text.match(/```diff\s*([\s\S]*?)```/m);
  if (!m) return null;
  const raw = m[1]!.trim();
  const patchText = raw + (raw.endsWith('\n') ? '' : '\n');

  const touchedPaths = new Set<string>();
  const lines = patchText.split('\n');
  let hasGitHeaders = false;

  for (const ln of lines) {
    // diff --git a/foo b/foo
    const mm = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (mm?.[2]) {
      hasGitHeaders = true;
      touchedPaths.add(mm[2]);
    }
  }

  return { patchText, touchedPaths: [...touchedPaths], hasGitHeaders };
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
