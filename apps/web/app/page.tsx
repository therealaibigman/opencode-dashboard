import { AppShell } from '../components/AppShell';
import { ProjectProvider } from '../components/ProjectContext';
import { TopTabs } from '../components/TopTabs';
import { ChatPanel } from '../components/ChatPanel';
import { HealthPanel } from '../components/HealthPanel';
import { KanbanPanel } from '../components/KanbanPanel';
import { RunsPanel } from '../components/RunsPanel';

type TabKey = 'chat' | 'kanban' | 'runs';

export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const sp = await searchParams;
  const tab = (sp.tab ?? '').toLowerCase();
  const initial: TabKey = tab === 'runs' ? 'runs' : tab === 'kanban' ? 'kanban' : 'chat';

  return (
    <ProjectProvider>
      <AppShell>
        <TopTabs initial={initial} chat={<ChatPanel />} kanban={<KanbanPanel />} runs={<RunsPanel />} />
      </AppShell>
    </ProjectProvider>
  );
}
