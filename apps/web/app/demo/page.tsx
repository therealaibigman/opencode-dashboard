'use client';

import { useEffect, useMemo, useState } from 'react';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export default function DemoPage() {
  const [runId, setRunId] = useState('run_demo');
  const [lines, setLines] = useState<string[]>([]);

  const url = useMemo(
    () => `${BASE_PATH}/api/runs/${encodeURIComponent(runId)}/events/stream`,
    [runId]
  );

  useEffect(() => {
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      setLines((prev) => [`message: ${ev.data}`, ...prev].slice(0, 1000));
    };
    es.addEventListener('run.step.progress', (ev) => {
      // @ts-ignore
      setLines((prev) => [`progress: ${ev.data}`, ...prev].slice(0, 1000));
    });
    es.onerror = () => {
      setLines((prev) => ['[SSE error / disconnected]', ...prev]);
    };
    return () => es.close();
  }, [url]);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h2 className="mb-2 text-lg font-semibold text-matrix-100">SSE Demo</h2>
      <p className="mb-4 text-xs text-zinc-300">basePath: {BASE_PATH || '(none)'}</p>

      <label className="mb-3 block text-sm text-zinc-200">
        Run ID:{' '}
        <input
          className="ml-2 rounded-md border border-matrix-500/20 bg-black/30 px-2 py-1 text-sm text-zinc-100 outline-none focus:ring-1 focus:ring-matrix-500/40"
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
        />
      </label>

      <p className="mb-3 text-xs text-zinc-300">Listening on: {url}</p>

      <pre className="h-[420px] overflow-auto rounded-xl border border-matrix-500/20 bg-black/35 p-3 text-xs text-zinc-200 shadow-neon">
        {lines.join('\n')}
      </pre>
    </main>
  );
}
