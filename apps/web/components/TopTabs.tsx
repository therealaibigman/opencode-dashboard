'use client';

import { useState } from 'react';

type TabKey = 'chat' | 'kanban';

export function TopTabs({
  initial = 'chat',
  chat,
  kanban
}: {
  initial?: TabKey;
  chat: React.ReactNode;
  kanban: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>(initial);

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-sm text-matrix-200/80">OpenCode Dashboard</div>
          <h1 className="text-xl font-semibold tracking-tight text-matrix-100">Control Room</h1>
        </div>

        <div className="flex items-center gap-2 rounded-xl bg-bg-2/60 p-1 shadow-neon backdrop-blur">
          <button
            onClick={() => setTab('chat')}
            className={
              tab === 'chat'
                ? 'rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40'
                : 'rounded-lg px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100'
            }
          >
            Chat
          </button>
          <button
            onClick={() => setTab('kanban')}
            className={
              tab === 'kanban'
                ? 'rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40'
                : 'rounded-lg px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100'
            }
          >
            Kanban
          </button>
        </div>
      </header>

      <section className="rounded-2xl border border-matrix-500/20 bg-bg-2/40 shadow-neon backdrop-blur">
        <div className="p-4 md:p-6">{tab === 'chat' ? chat : kanban}</div>
      </section>
    </div>
  );
}
