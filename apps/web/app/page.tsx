import { TopTabs } from '../components/TopTabs';
import { ChatPanel } from '../components/ChatPanel';
import { KanbanPanel } from '../components/KanbanPanel';

export default function HomePage() {
  return <TopTabs chat={<ChatPanel />} kanban={<KanbanPanel />} />;
}
