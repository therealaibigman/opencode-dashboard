'use client';

import { useTheme } from 'next-themes';
import { useSettings } from './useSettings';

export function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  const { settings, setYolo, setModelProfile } = useSettings();

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Look</div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35"
          >
            Theme: {theme ?? 'dark'}
          </button>
          <div className="text-xs text-zinc-400">High contrast. No mercy.</div>
        </div>
      </div>

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3">
        <div className="mb-2 text-xs font-medium text-matrix-200/90">Run defaults</div>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-2 text-xs text-zinc-400">Model profile</div>
            <select
              value={settings.modelProfile}
              onChange={(e) => setModelProfile(e.target.value)}
              className="w-full rounded-lg border border-matrix-500/20 bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none"
            >
              <option value="balanced">balanced</option>
              <option value="fast">fast</option>
              <option value="smart">smart</option>
              <option value="strict">strict</option>
            </select>
            <div className="mt-1 text-[11px] text-zinc-500">
              This is just a label passed to the worker as <span className="font-mono">model_profile</span>.
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs text-zinc-400">YOLO mode</div>
            <button
              onClick={() => setYolo(!settings.yolo)}
              className={
                settings.yolo
                  ? 'w-full rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-100 ring-1 ring-red-500/30 hover:bg-red-500/20'
                  : 'w-full rounded-lg bg-black/25 px-3 py-2 text-sm text-zinc-200 ring-1 ring-matrix-500/20 hover:bg-black/35'
              }
            >
              {settings.yolo ? 'YOLO: ON' : 'YOLO: OFF'}
            </button>
            <div className="mt-1 text-[11px] text-zinc-500">
              Local UI flag. Real approvals are enforced by server env (e.g. <span className="font-mono">OC_DASH_REQUIRE_APPROVAL=1</span>).
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-matrix-500/20 bg-black/20 p-3 text-xs text-zinc-300">
        GSD rules: ship, log, verify.
      </div>
    </div>
  );
}
