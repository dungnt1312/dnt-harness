# Frontend performance review — web/

Date: 2026-09-23 · Branch: feat/workbench-terminal · Scope: `web/` (React 19, Vite 6)

## Evidence

- Largest real session log: 20,965 events, **20,345 are `assistant/chunk`** (97%). Server emits one event per model token (`src/harness/agent/agent.ts:374`).
- Node bench on that log (per call): array spread 0.22 ms · `projectItems` 1.42 ms · `isTurnRunning` 0.37 ms · `taskPhase` 0.59 ms · JSON parse of the full snapshot 28.6 ms.
- Build: main chunk `index-*.js` 950 KB minified; only `TerminalPanel` is split (342 KB).
- Not measured: in-browser React commit time. Conclusions below come from code paths + the numbers above.

## Already fixed (this session, uncommitted)

- Typing: draft moved to `web/lib/composer-store.ts` (`useSyncExternalStore`) → keystroke re-renders only the composer; persistence debounced 300 ms + flush on `pagehide`.
- `Markdown` memoized, stable `components`/plugins (previously remounted every element per render); `CodeBlock` memoizes highlight.
- `Transcript` memoized with stable callbacks from `App`.

## Findings (priority order)

### P1 — Every streamed token re-renders the whole app
`web/hooks/useSessionStream.ts:50` does `setEvents([...prev, event])` per SSE message. Each token → full `App` render → Sidebar, Workbench, TaskStatus, Transcript, Minimap all re-run. Data passes are cheap (~3 ms total); the cost is React rendering the whole tree 30–100×/s while streaming.
**Fix:** buffer envelopes in a ref and flush once per animation frame (one `setEvents` with all buffered events). Keeps order/seq semantics; cuts renders to ≤1 per frame.

### P1 — Projection rebuilds every item, so row memoization cannot work
`projectItems` (`web/lib/project.ts:91`) creates new objects for all items per event. `Transcript` is memoized, but `items` changes every token and every row (`UserBubble` → `parseMessageText`, `ToolCard` → `toolFacts`, `ThinkingPanel` → `thinking.join`, `ActivityBlock` → `summarizeActivity`) re-renders.
**Fix:** structural sharing — after projecting, reuse the previous item object when its fields are unchanged (key by position/call id), then `memo` the row components. Only the live message re-renders during a stream.

### P2 — Live answer re-parses full markdown per token
The streaming `AssistantMessage` passes growing `content` to `react-markdown`: full remark+GFM parse per token → O(n²) per answer; long answers with tables/code get progressively slower.
**Fix (pick one):** throttle live content to ~100 ms; or split markdown into top-level blocks and memo each block so only the last block re-parses.

### P2 — Minimap forces layout on every token
`ConversationMinimap.tsx:84–124`: `measure` depends on `entries`, which is recomputed whenever `items` changes → effect tears down/re-creates observers and calls `measure()` synchronously per token (`querySelector` + `getBoundingClientRect` per user message = forced layout). The content ResizeObserver also fires per token. `setPositioned` always sets a new array.
**Fix:** derive entries only from user messages (stable unless a user message is added), keep `measure` in a ref, skip `setState` when positions are unchanged.

### P2 — Conversation open ships the whole raw log
Snapshot sends all events including ~20k chunks (3.5 MB for the largest session): transfer + ~29 ms parse + projection before first paint.
**Fix (server + contract):** in snapshots, drop `assistant/chunk` for steps that already have `assistant/message` (the full content is there). Needs a decision: it changes the SSE snapshot contract.

### P3 — Background full re-renders
- 10 s poll (`App.tsx:608`) → `refreshList`/`refreshWorkspaces` set new arrays even when unchanged → full app render every 10 s. Fix: skip `setState` when data is equal.
- Manifest effect (`App.tsx:707`) runs `setManifest(null)` on every `events.length` change, including while running.

### P3 — Per-render O(n) work outside the transcript
- `TaskStatus.tsx:13–14`: `taskPhase` + `events.some` every render → `useMemo`.
- `Workbench.tsx:179`: `events.filter(...)` every render → `useMemo`.
- `ArtifactsPanel.tsx:44`: `projectArtifacts(events)` every render → `useMemo`.
- `Workbench`/`Sidebar` are not memoized and receive inline props; lower priority once P1 lands.

### P3 — Bundle
Single 950 KB main chunk. Candidates for `lazy()`: `SettingsModal` and its panels (only needed when opened), and possibly the highlight.js language set. Local-first app, so this mostly affects cold load, not interaction.

## Suggested order
1. P1 frame-batching in `useSessionStream` (small, isolated, biggest win).
2. P1 structural sharing + row `memo`.
3. P2 minimap, P2 live-markdown throttle.
4. P3 items (quick `useMemo`s, equality guards on polling).
5. P2 snapshot compaction and bundle splitting once decided.

## Implementation follow-up (2026-09-23)

- Done: `useSessionStream` batches the event array at most once per animation frame, keeps sequence deduplication and snapshot/cleanup fencing, while approval state stays immediate (including settlement before a frame flush).
- Done: `shareProjectedItems` reuses unchanged projected rows; user/assistant/tool/delegation/audit rows memoize. Assistant footer comparison uses its text, not the freshly allocated footer object.
- Done: the minimap retains user-only entries across assistant streaming, avoids rebuilding observers, throttles content ResizeObserver geometry passes to at most one per ~150 ms, and skips unchanged geometry/viewport state. Live markdown updates at most roughly every 100 ms and shows finalized content immediately.
- Done: polling keeps unchanged listing arrays; TaskStatus, Workbench child-event count, and ArtifactsPanel memoize event-derived scans. The manifest refresh now keys off the latest `turn/end` and explicit compaction rather than each chunk; conversation switches still clear stale manifest.
- Verification: red/green regression tests for each change; final full suite 974/974 passed, `npm run typecheck` and `npm run build:web` passed, `git diff --check` clean. One earlier full-suite run had 974 passing assertions but exited nonzero on an intermittent Windows MCP stdio `EPIPE`; an immediate full rerun passed. An earlier provider-sync 502 similarly passed on isolated retry and later full runs.
- Done: SettingsModal and its panels load on first open rather than in the initial bundle; afterward the modal remains mounted when closed, retaining its prior lifecycle. Main JS fell from 963.87 KB to 823.85 KB minified (−140.02 KB); SettingsModal is a separate 141.42 KB chunk. The main chunk still exceeds Vite's 500 KB warning threshold.
- Deferred: snapshot compaction would change the public SSE snapshot contract, including the existing test that expects a full replay (`tests/web/server.spec.ts`); no server/event-log changes made. Browser React Profiler commit timings were not measured; the improvement is verified by behavior tests, not an in-browser benchmark.

## Remaining decisions
- If snapshot compaction is authorized, decide whether to version the SSE snapshot contract or add a separate UI-optimized snapshot endpoint while preserving full replay for other clients.
- Measure React commits on the 21k-event session before claiming a numerical interaction-speed improvement.
