'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useBasePath } from './useBasePath';

export type Project = { id: string; name: string };

type Ctx = {
  projects: Project[];
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  refreshProjects: () => Promise<void>;
};

const ProjectContext = createContext<Ctx | null>(null);

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const BASE = useBasePath();
  const api = useMemo(() => ({ projects: `${BASE}/api/projects` }), [BASE]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('prj_demo');

  async function refreshProjects() {
    const data = await j<{ projects: Project[] }>(await fetch(api.projects, { cache: 'no-store' }));
    setProjects(data.projects);

    // If selection is invalid (deleted), pick the first available project.
    if (data.projects.length && !data.projects.find((p) => p.id === selectedProjectId)) {
      setSelectedProjectId(data.projects[0]!.id);
    }
  }

  useEffect(() => {
    refreshProjects().catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.projects]);

  const value: Ctx = {
    projects,
    selectedProjectId,
    setSelectedProjectId,
    refreshProjects
  };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within <ProjectProvider>');
  return ctx;
}
