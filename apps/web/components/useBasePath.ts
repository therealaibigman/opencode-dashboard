'use client';

export function useBasePath() {
  // Prefer explicit env at build time.
  const env = process.env.NEXT_PUBLIC_BASE_PATH;
  if (env && env.trim()) return env.trim();

  // Fallback: infer from current URL when deployed under a Next.js basePath.
  // Example: /ocdash/runs/<id>  -> basePath = /ocdash
  if (typeof window !== 'undefined') {
    const p = window.location.pathname || '';
    const m = p.match(/^\/([^\/]+)(\/|$)/);
    if (m?.[1] && m[1] !== 'runs' && m[1] !== 'api') {
      // In this repo we deploy under /ocdash. This inference keeps local dev working.
      return `/${m[1]}`;
    }
  }

  return '';
}
