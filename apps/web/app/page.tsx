import Link from 'next/link';

export default function HomePage() {
  return (
    <main style={{ padding: 24 }}>
      <h1>OpenCode Dashboard</h1>
      <p>Minimal scaffold. Run SSE stream for a run:</p>
      <pre style={{ background: '#111', color: '#eee', padding: 12, borderRadius: 8 }}>
        GET /api/runs/&lt;runId&gt;/events/stream
      </pre>
      <p>
        Try: <Link href="/demo">/demo</Link>
      </p>
    </main>
  );
}
