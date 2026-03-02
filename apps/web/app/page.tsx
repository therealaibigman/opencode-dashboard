import Link from 'next/link';
import { TopTabs } from '../components/TopTabs';

function ChatPanel() {
  return (
    <div className="space-y-3">
      <div className="text-sm text-zinc-300">
        Webchat UI goes here. For now, use the SSE demo to confirm streaming.
      </div>
      <div className="flex gap-3">
        <Link
          href="/demo"
          className="rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40 hover:bg-matrix-500/20"
        >
          Open SSE Demo
        </Link>
      </div>
      <div className="rounded-xl border border-matrix-500/20 bg-black/30 p-3 text-xs text-zinc-200">
        Next: chat messages → create tasks/runs.
      </div>
    </div>
  );
}

function KanbanPanel() {
  const cols = ['Inbox', 'Planned', 'In Progress', 'Blocked', 'Review', 'Done'];
  return (
    <div className="space-y-3">
      <div className="text-sm text-zinc-300">Kanban UI goes here.</div>
      <div className="grid gap-3 md:grid-cols-6">
        {cols.map((c) => (
          <div key={c} className="rounded-xl border border-matrix-500/15 bg-black/20 p-3">
            <div className="mb-2 text-xs font-medium text-matrix-200/90">{c}</div>
            <div className="rounded-lg border border-matrix-500/10 bg-black/25 p-2 text-xs text-zinc-300">
              Empty
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  return <TopTabs chat={<ChatPanel />} kanban={<KanbanPanel />} />;
}
