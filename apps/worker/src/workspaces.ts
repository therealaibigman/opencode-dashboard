import path from 'node:path';
import fs from 'node:fs/promises';

export async function ensureProjectWorkspace({
  root,
  projectId
}: {
  root: string;
  projectId: string;
}): Promise<string> {
  const dir = path.resolve(root, projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
