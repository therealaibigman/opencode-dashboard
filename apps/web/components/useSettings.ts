'use client';

import { useEffect, useMemo, useState } from 'react';

export type OcdashSettings = {
  yolo: boolean;
  modelProfile: string;
  defaultPipelineId: string;
  runsPageSize: number;
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
  const [settings, setSettings] = useState<OcdashSettings>({
    yolo: false,
    modelProfile: 'balanced',
    defaultPipelineId: '',
    runsPageSize: 100
  });

  useEffect(() => {
    const stored = safeParse(typeof window !== 'undefined' ? window.localStorage.getItem(KEY) : null);
    setSettings({
      yolo: Boolean(stored.yolo ?? false),
      modelProfile: String(stored.modelProfile ?? 'balanced'),
      defaultPipelineId: String(stored.defaultPipelineId ?? ''),
      runsPageSize: Math.max(1, Number(stored.runsPageSize ?? 100) || 100)
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
      setModelProfile: (modelProfile: string) => setSettings((s) => ({ ...s, modelProfile })),
      setDefaultPipelineId: (defaultPipelineId: string) => setSettings((s) => ({ ...s, defaultPipelineId })),
      setRunsPageSize: (runsPageSize: number) =>
        setSettings((s) => ({ ...s, runsPageSize: Math.max(1, Math.min(500, Math.floor(runsPageSize || 100))) }))
    }),
    []
  );

  return { settings, ...api };
}
