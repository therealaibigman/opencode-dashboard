'use client';

import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';

import { useBasePath } from './useBasePath';

function ThemeSyncer() {
  const base = useBasePath();
  const { theme, setTheme } = useTheme();
  const hydratedRef = useRef(false);
  const lastSavedRef = useRef<string>('');

  // On first mount: pull theme from DB and apply.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    void (async () => {
      try {
        const res = await fetch(`${base}/api/settings`, { cache: 'no-store' });
        const json = (await res.json().catch(() => null)) as any;
        const dbTheme = String(json?.settings?.theme ?? '').trim();
        if (dbTheme === 'dark' || dbTheme === 'light') {
          lastSavedRef.current = dbTheme;
          // Only override if different (avoids flicker loops).
          if (theme !== dbTheme) setTheme(dbTheme);
        }
      } catch {
        // ignore
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // Whenever theme changes: persist to DB (best-effort).
  useEffect(() => {
    const t = String(theme ?? '').trim();
    if (t !== 'dark' && t !== 'light') return;
    if (t === lastSavedRef.current) return;

    lastSavedRef.current = t;

    void (async () => {
      try {
        await fetch(`${base}/api/settings`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ theme: t })
        });
      } catch {
        // ignore
      }
    })();
  }, [theme, base]);

  return null;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem={false}>
      <ThemeSyncer />
      {children}
    </NextThemesProvider>
  );
}
