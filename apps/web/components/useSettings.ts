'use client';

import { useEffect, useMemo, useState } from 'react';

export type OcdashSettings = {
  yolo: boolean;
  modelProfile: string;
};

const KEY = 'ocdash:settings:v1';

function safeParse(v: string | null): Partial<OcdashSettings> {
  if (!v) return {};
  try {
    return JSON.parse(v) as Partial<OcdashSettings>;
  } catch {
    return {};
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<OcdashSettings>({ yolo: false, modelProfile: 'balanced' });

  useEffect(() => {
    const stored = safeParse(typeof window !== 'undefined' ? window.localStorage.getItem(KEY) : null);
    setSettings({
      yolo: Boolean(stored.yolo ?? false),
      modelProfile: String(stored.modelProfile ?? 'balanced')
    });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);

  const api = useMemo(
    () => ({
      setYolo: (yolo: boolean) => setSettings((s) => ({ ...s, yolo })),
      setModelProfile: (modelProfile: string) => setSettings((s) => ({ ...s, modelProfile }))
    }),
    []
  );

  return { settings, ...api };
}
