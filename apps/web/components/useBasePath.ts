'use client';

export function useBasePath() {
  // Prefer explicit env at build time.
  const env = process.env.NEXT_PUBLIC_BASE_PATH;
  if (env && env.trim()) return env.trim();
  return '';
}
