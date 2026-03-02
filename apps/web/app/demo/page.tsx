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
    <main style={{ padding: 24 }}>
      <h2>SSE Demo</h2>
      <p>basePath: {BASE_PATH || '(none)'}</p>
      <label>
        Run ID:{' '}
        <input value={runId} onChange={(e) => setRunId(e.target.value)} />
      </label>
      <p>Listening on: {url}</p>
      <pre
        style={{
          background: '#111',
          color: '#eee',
          padding: 12,
          borderRadius: 8,
          height: 420,
          overflow: 'auto'
        }}
      >
        {lines.join('\n')}
      </pre>
    </main>
  );
}
