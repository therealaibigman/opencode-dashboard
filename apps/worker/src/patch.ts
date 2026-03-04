import fs from 'node:fs/promises';
import path from 'node:path';

export type PatchExtract = {
  patchText: string;
  touchedPaths: string[];
};

// Very simple extractor: grabs the first ```diff ...``` fenced block.
export function extractUnifiedDiffFromText(text: string): PatchExtract | null {
  const m = text.match(/```diff\s*([\s\S]*?)```/m);
  if (!m) return null;
  const patchText = m[1]!.trim() + '\n';

  const touchedPaths = new Set<string>();
  const lines = patchText.split('\n');
  for (const ln of lines) {
    // diff --git a/foo b/foo
    const mm = ln.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (mm?.[2]) touchedPaths.add(mm[2]);
  }

  return { patchText, touchedPaths: [...touchedPaths] };
}

export async function writeTempPatch({ dir, patchText }: { dir: string; patchText: string }) {
  const p = path.join(dir, `.ocdash_patch_${Date.now()}_${Math.random().toString(16).slice(2)}.diff`);
  await fs.writeFile(p, patchText, 'utf8');
  return p;
}
