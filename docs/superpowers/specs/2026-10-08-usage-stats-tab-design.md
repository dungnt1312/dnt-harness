# Settings → Usage tab (token statistics)

Status: approved. The user delegated the decisions and gave a reference screenshot on 2026-10-08.

## Goal

Add a **Usage** tab to Settings, in the Global group next to Providers. It
shows token statistics across every workspace, following the reference
layout:

1. **Stat strip** with 5 cells: Total tokens · Peak tokens · Longest session · Current streak · Longest streak.
2. **Token activity**: a GitHub-style heatmap covering 53 weeks × 7 days, with
   month labels underneath. It has a segmented toggle **Daily / Weekly / Cumulative**.
3. **Time range** toggle: **Last 7 days / Last 30 days**.
4. **Daily token trend chart**: one smooth line per model, a legend on top,
   and date ticks along the x axis.

## Current state (why storage is needed)

- Providers emit `{ type: 'usage', usage: TokenUsage }` (`src/harness/llm/types.ts`:
  `inputTokens`, `cachedInputTokens?`, `outputTokens?`).
- `src/web/server.ts` taps `llm/stream` and folds usage into the in-memory
  `sessionUsage` map. That map only feeds the context meter. It is lost on
  restart and is never written to the session log.
- So no historical usage exists. **The tab starts from zero**: there is no
  backfill, because there is no data to rebuild from.

## Decisions

| Topic | Decision | Reason |
|---|---|---|
| Storage | Global append-only `<appHome>/usage.jsonl`, one line per completed request | Usage is cross-workspace. JSONL matches the existing logs (`events.jsonl`, `executions.jsonl`). It needs no new dependency. |
| Not in the session log | Do not add a `usage` SessionEvent | That would change the event schema, the replay and the SSE wire just for one statistics feature. A deleted session's tokens should still count. |
| Aggregation | Server keeps an in-memory index by `date × model` that is rebuilt on boot by streaming the file | 1 line per request means tens of thousands of lines/year, so the rebuild is cheap. |
| API | One endpoint returning daily rows. The client computes the stats. | The stat logic stays as pure functions that are easy to test. The payload is small: ≤ 371 days × the number of models. |
| Chart | Hand-written SVG, no chart library | The repo has no chart dependency. The two charts are simple. |
| Scope | Global (all workspaces) | Matches the screenshot. A workspace filter is out of scope for v1. |
| Timezone | Day buckets use the **host's local** timezone | The host and the browser run on the same machine. This avoids sending a TZ offset. |

## Record format (`usage.jsonl`)

```jsonc
{"v":1,"at":1791459600000,"startedAt":1791459590000,
 "workspaceId":"ws-…","sessionId":"session-…","rootSessionId":"session-…",
 "kind":"turn",            // "turn" | "child" | "compaction"
 "provider":"cliproxy","model":"claude-opus-5-5",
 "input":12345,"cached":9000,"output":812}
```

- `at`: when the stream reported usage (ms epoch). `startedAt`: when the tap started the request.
- `model`: `request.model`. If that is missing, use the provider's default model name, and if that is unknown too, use `"unknown"`.
- `kind`: `child` when `agentScope.childOf` is set. `compaction` for the
  summarizer. The summarizer deliberately runs `agentScope.exit(...)`, so the
  tap cannot see it. The summarizer therefore calls `usageLog.record(...)`
  itself, using the `attribution.sessionId` it already has.
- If a request reports usage more than once (some providers do), only the **last** report is kept, written when the stream ends.
- If a stream aborts before it reports usage, nothing is recorded. We do not estimate.
- Writes are append-only and **not** fsynced per line (see memory perf-review: fsync-per-token was removed). Writes are queued in one promise chain so lines cannot interleave.
- When reading back, a corrupted or truncated line (e.g. after a crash) is skipped. A record with `v` ≠ 1 is skipped too.

## Module

`src/web/usage-log.ts` (new, no dependencies on `server.ts`):

```ts
export interface UsageRecord { v: 1; at; startedAt; workspaceId?; sessionId; rootSessionId; kind; provider?; model; input; cached; output }
export interface UsageLog {
  record(r: Omit<UsageRecord, 'v'>): void          // fire-and-forget, serialized append
  daily(): UsageDailyResponse                      // from the in-memory index
}
export async function openUsageLog(file: string, now?: () => number): Promise<UsageLog>
```

In-memory index:
- `byDay: Map<'YYYY-MM-DD', Map<model, {input, cached, output, requests}>>`
- `sessions: Map<rootSessionId, Array<[startedAt, at]>>`. This is only used to
  compute "Longest session" (see below). The server computes the result and
  returns only the number, so the session list never goes over the wire.

## API

`GET /api/usage` → 200

```jsonc
{
  "days": [ { "date": "2026-10-01", "model": "claude-opus-5-5", "input": 1, "cached": 0, "output": 2, "requests": 3 } ],
  "longestSessionMs": 25020000,
  "firstRecordAt": 1791000000000,   // absent when empty
  "today": "2026-10-08"             // host-local date, so the client never guesses the TZ
}
```

`days` covers the last 371 days (53 weeks plus padding). Older data stays in
the file but is not sent.

## Metric definitions (pure, in `web/lib/usage-stats.ts`)

- **tokens of a record** = `input + output`. `input` already includes `cached`, following the provider's convention.
- **Total tokens**: the sum over all `days` that were returned. "All time" is limited to 371 days, which is enough for v1.
- **Peak tokens**: the highest single-day total, summed across all models.
- **Longest session**: computed on the server, per `rootSessionId`, so child
  agents count toward their root session. Sort the `[startedAt, at]` intervals,
  merge any whose gap is ≤ 30 minutes, and take the longest merged block. A
  session left idle overnight must not count as 14 hours. Display format:
  `6 h 57 m`, `42 m`, or `—` when there is no data.
- **Current streak**: consecutive days with tokens > 0, counting back from
  `today`. If today has nothing yet, start counting from yesterday, so the
  streak does not drop to 0 first thing in the morning (the same convention as
  GitHub).
- **Longest streak**: the longest run of consecutive days with tokens > 0. Display format: `N d`.
- Number format: compact, as in the screenshot: `1.9B`, `306.2M`, `12.4K`, `812`.

## UI

`web/components/settings/UsagePanel.tsx`. It is lazy-loaded like the other
panels (`LazySettings.tsx`) and uses `PanelBody` / `Section` from `settings-kit.tsx`.

- **Tab registration** (`SettingsModal.tsx`): `SettingsTab` gets `'usage'`. `TABS` gets
  `{ id: 'usage', label: 'Usage', hint: 'Token usage across workspaces', icon: 'layers' }`, or a new `barChart` icon if a matching icon exists. `TAB_GROUPS.Global` becomes `['providers', 'usage']`.
- **Stat strip**: one card with 5 equal columns separated by vertical dividers.
  The value is bold and the label sits underneath in `text-fg-muted`. On narrow
  screens it wraps to 3+2 columns (see the tablet responsive contract in memory).
- **Heatmap**: an SVG grid of 53 columns (weeks) × 7 rows. Weeks start on
  **Sunday**, as in the screenshot. The last column contains `today`, and days
  after today are not drawn. Colour comes from 5 levels: empty cells use the
  `bg-muted` tone, and levels 1–4 are graded opacities of `--link` (the blue in
  the screenshot). Levels are set by quantiles of the non-zero values, so one
  huge day does not wash the rest out. Month labels sit under the column where
  each month starts.
  - *Daily*: each cell is that day's total.
  - *Weekly*: every cell in a column takes the colour of that week's total.
  - *Cumulative*: each cell is the running total up to that day, so the colour rises monotonically.
  - Each cell has a native `<title>` tooltip: `Oct 6, 2026 · 12.4M tokens`.
    Cells use `role="img"`, and the whole grid gets an `aria-label` that
    summarizes it.
- **Time range**: `Segmented` with the options `7d` / `30d`. The default is 7d.
- **Daily token trend chart**: SVG with a viewBox that scales to the panel width.
  - One series per model, ordered by total tokens in the range, highest first.
    Show at most **8** models; the rest are grouped into "Other".
  - Colours come from a fixed palette of 8 colours that works in both themes. A model always gets the same colour, based on its rank within the range.
  - Lines use monotone cubic interpolation (Fritsch–Carlson), so a curve never dips below 0 the way a Catmull-Rom spline can.
  - Faint dashed horizontal grid lines and x-axis tick labels `Oct 1 … Oct 8`. With 30 days, a tick appears only about every 5 days.
  - The legend is a row of dots and names, as in the screenshot. Clicking a legend entry toggles that series on or off. Hover tooltips are not in v1; native `<title>` on each point is enough.
- **Empty state**: when there are no records at all, show a `PanelIntro` /
  `EmptyState` saying "Usage is recorded from now on — previous requests were not
  tracked." All widgets still render so the layout does not jump.
- **Refresh**: fetch when the tab opens. There is a Refresh `IconButton` in the header. No polling.

## Errors

- If `usage.jsonl` cannot be opened at boot, log a warning. `record()` becomes a no-op, the API returns empty `days`, and the host keeps running.
- If an append fails, log a warning once (throttled). The turn is not affected.
- If the API fails, the panel shows `ErrorNotice` with a Retry button.

## Tests

- `src/web/usage-log.spec.ts`:
  - append → reopen → `daily()` rebuilds the same data;
  - a truncated or bad line is skipped;
  - day bucketing uses local TZ;
  - merging session intervals with a 30-minute gap;
  - concurrent appends do not interleave.
- `web/lib/usage-stats.spec.ts`:
  - total/peak;
  - current streak where today is empty but yesterday has data;
  - longest streak;
  - heatmap grid alignment (Sunday start, today in the last column);
  - weekly and cumulative modes;
  - quantile levels;
  - top-8 plus "Other" grouping;
  - compact number format.
- Server integration (existing pattern in `tests/web`): a fake provider emits
  `usage`, a turn runs, and `GET /api/usage` returns the matching row with the
  right model and `kind`.
- `web/components/settings/usage-panel.spec.tsx`:
  - renders 5 stats from fixture data;
  - toggling Daily/Weekly/Cumulative changes the cells;
  - toggling 7d/30d changes the number of x-axis points;
  - the empty state appears when there is no data.

## Out of scope (v1)

Cost in $ (needs a price table), filtering by workspace or project, export,
tokens per session or per child agent, rotation or compaction of `usage.jsonl`,
backfill.

## Files touched

- new `src/web/usage-log.ts` and spec
- `src/web/server.ts`: open the log at boot, record from the `llm/stream` tap, route `GET /api/usage`
- `src/web/llm-summarizer.ts` (or the place in `server.ts` that calls the summarizer): record compaction usage
- new `web/lib/usage-stats.ts` and spec
- `web/lib/api.ts` (`fetchUsage`), `web/lib/types.ts` (`UsageDailyResponse`)
- new `web/components/settings/UsagePanel.tsx` and spec
- `web/components/settings/SettingsModal.tsx`, `LazySettings.tsx`
- `docs/web.md`: one paragraph on the Usage tab and `usage.jsonl`
