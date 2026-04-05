'use client';

import { useEffect, useState } from 'react';

type TabKey = 'chat' | 'kanban' | 'runs' | 'gsd' | 'ralph' | 'settings';

export function TopTabs({
  initial = 'chat',
  chat,
  kanban,
  runs,
  gsd,
  ralph,
  settings
}: {
  initial?: TabKey;
  chat: React.ReactNode;
  kanban: React.ReactNode;
  runs: React.ReactNode;
  gsd: React.ReactNode;
  ralph: React.ReactNode;
  settings: React.ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>(initial);

  useEffect(() => {
    setTab(initial);
  }, [initial]);

  return (
    <div className="flex h-full min-h-[calc(100vh-48px)] flex-col">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="md:hidden">
          <div className="text-xs text-matrix-200/80">OpenCode Dashboard</div>
          <h1 className="text-lg font-semibold tracking-tight text-matrix-100">Control Room</h1>
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
          <button
            onClick={() => setTab('runs')}
            className={
              tab === 'runs'
                ? 'rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40'
                : 'rounded-lg px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100'
            }
          >
            Runs
          </button>
          <button
            onClick={() => setTab('gsd')}
            className={
              tab === 'gsd'
                ? 'rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40'
                : 'rounded-lg px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100'
            }
          >
            GSD
          </button>
          <button
            onClick={() => setTab('ralph')}
            className={
              tab === 'ralph'
                ? 'rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40'
                : 'rounded-lg px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100'
            }
          >
            Ralph
          </button>
          <button
            onClick={() => setTab('settings')}
            className={
              tab === 'settings'
                ? 'rounded-lg bg-matrix-500/15 px-3 py-2 text-sm text-matrix-100 ring-1 ring-matrix-500/40'
                : 'rounded-lg px-3 py-2 text-sm text-zinc-300 hover:text-zinc-100'
            }
          >
            Settings
          </button>
        </div>
      </header>

      <section className="flex-1 rounded-2xl border border-matrix-500/20 bg-bg-2/40 shadow-neon backdrop-blur">
        <div className="h-full p-4 md:p-6">
          {tab === 'chat' ? chat : tab === 'kanban' ? kanban : tab === 'runs' ? runs : tab === 'gsd' ? gsd : tab === 'ralph' ? ralph : settings}
        </div>
      </section>
    </div>
  );
}
