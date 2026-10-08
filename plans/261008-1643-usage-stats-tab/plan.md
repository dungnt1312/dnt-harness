# Plan: Settings → Usage tab

Spec: `docs/superpowers/specs/2026-10-08-usage-stats-tab-design.md`

## Phases

1. `src/web/usage-log.ts`: append-only JSONL, in-memory index, `daily()`, longest session. Spec: `src/web/usage-log.spec.ts`.
2. `src/web/server.ts`: open the log at boot, record usage from the `llm/stream` tap (turn/child) and from the compaction summarizer, and add `GET /api/usage`.
3. `web/lib/usage-stats.ts`: pure stats (total, peak, streaks, heatmap grid and levels, trend series, compact format). Spec included.
4. `web/components/settings/UsagePanel.tsx`: register the tab in `SettingsModal.tsx` / `LazySettings.tsx`, add `fetchUsage` and types. Spec included.
5. Verify: typecheck, the targeted vitest specs, and a paragraph in `docs/web.md`.

## Acceptance

- After a turn, `GET /api/usage` returns a row for that turn's model with the correct tokens. The data survives a restart.
- The tab shows 5 stats, a heatmap with Daily/Weekly/Cumulative, a 7d/30d toggle, and a trend chart with one line per model.
- The empty state shows when there is no data. Errors show with a Retry button.

## Status

- [x] 1 · [x] 2 · [x] 3 · [x] 4 · [x] 5
