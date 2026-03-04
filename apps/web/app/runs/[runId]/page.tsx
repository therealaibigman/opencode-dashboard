import { AppShell } from '../../../components/AppShell';
import { ProjectProvider } from '../../../components/ProjectContext';
import { RunDetails } from '../../../components/RunDetails';

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  return (
    <ProjectProvider>
      <AppShell title={`Run ${runId}`}>
        <RunDetails runId={runId} />
      </AppShell>
    </ProjectProvider>
  );
}
