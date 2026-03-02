import { AppShell } from '../components/AppShell';
import { ProjectProvider } from '../components/ProjectContext';
import { TopTabs } from '../components/TopTabs';
import { ChatPanel } from '../components/ChatPanel';
import { KanbanPanel } from '../components/KanbanPanel';

export default function HomePage() {
  return (
    <ProjectProvider>
      <AppShell>
        <TopTabs chat={<ChatPanel />} kanban={<KanbanPanel />} />
      </AppShell>
    </ProjectProvider>
  );
}
