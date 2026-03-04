import { AppShell } from '../components/AppShell';
import { ProjectProvider } from '../components/ProjectContext';
import { TopTabs } from '../components/TopTabs';
import { ChatPanel } from '../components/ChatPanel';
import { KanbanPanel } from '../components/KanbanPanel';
import { RunsPanel } from '../components/RunsPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { GsdPanel } from '../components/GsdPanel';

type TabKey = 'chat' | 'kanban' | 'runs' | 'gsd' | 'settings';

export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const tab = (sp.tab ?? '').toLowerCase();
  const initial: TabKey =
    tab === 'runs' ? 'runs' : tab === 'kanban' ? 'kanban' : tab === 'gsd' ? 'gsd' : tab === 'settings' ? 'settings' : 'chat';

  return (
    <ProjectProvider>
      <AppShell>
        <TopTabs
          initial={initial}
          chat={<ChatPanel />}
          kanban={<KanbanPanel />}
          runs={<RunsPanel />}
          gsd={<GsdPanel />}
          settings={<SettingsPanel />}
        />
      </AppShell>
    </ProjectProvider>
  );
}
