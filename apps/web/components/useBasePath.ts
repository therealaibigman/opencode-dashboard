'use client';

export function useBasePath() {
  // NEXT_PUBLIC_BASE_PATH is injected at build time.
  return process.env.NEXT_PUBLIC_BASE_PATH ?? '';
}
