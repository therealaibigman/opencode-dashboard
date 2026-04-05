import { AppShell } from '../../../components/AppShell';
import { ProjectProvider } from '../../../components/ProjectContext';
import { AdminRunsPanel } from '../../../components/AdminRunsPanel';

export default function AdminRunsPage() {
  return (
    <ProjectProvider>
      <AppShell title="Admin">
        <AdminRunsPanel />
      </AppShell>
    </ProjectProvider>
  );
}
