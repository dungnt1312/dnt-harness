# Phase 3 — Client: xterm panel with tabs

## Context

`web/components/workbench/Workbench.tsx` hosts Files / Context / Artifacts through a
`role="toolbar"` + `aria-pressed` button group (noted as a deliberate deviation in the
Warm Studio plan). Terminal becomes a fourth view in that same group. The Workbench docks
at ≥1280px and is a modal sheet below — xterm needs a real measured size, so fitting must
react to becoming visible, not only to window resize.

## Requirements

- Real xterm rendering with the project's warm design tokens, light and dark.
- Tab strip, shell picker on new tab, "+" disabled at the cap.
- Reattach on mount from the SSE snapshot; never clear a live session on remount.
- The panel's ~250 KB must stay out of the initial bundle.

## Files

| File | Change |
|---|---|
| `web/components/workbench/TerminalPanel.tsx` | **new** — tab strip, xterm host, input/resize plumbing |
| `web/components/workbench/Workbench.tsx` | edit — register the Terminal view, `React.lazy` the panel |
| `web/lib/api.ts` | edit — terminal REST calls + `EventSource` subscription |
| `web/lib/types.ts` | edit — `TerminalInfo`, `ShellOption`, `TerminalEnvelope` mirrors |
| `web/styles/app.css` | edit — xterm theme bound to existing tokens |
| `web/components/workbench/terminal.spec.tsx` | **new** |

Dependencies: `@xterm/xterm@^6.0.0`, `@xterm/addon-fit@^0.11.0`.

## Steps

1. **API layer.** Mirror the Phase 2 routes in `web/lib/api.ts` and subscribe to
   `…/terminals/events` with `EventSource`, reusing the existing reconnect handling. One
   subscription per workspace, shared by every tab.

2. **Panel.** `TerminalPanel` owns a `Map<terminalId, Terminal>` of xterm instances.
   Switching tabs shows/hides DOM nodes rather than disposing instances, so scrollback and
   cursor state survive tab switching without a server round trip.

3. **Input.** Keystrokes from `term.onData` accumulate and POST on a 16 ms timer — one
   request per frame instead of one per character. Batching is what makes SSE + POST
   viable here; without it a fast typist issues 80 requests a second.

4. **Resize.** `FitAddon` on a `ResizeObserver` over the panel, plus a re-fit when the
   view becomes visible or the Workbench sheet opens. The resulting `cols`/`rows` POST is
   debounced 100 ms, because dragging the panel divider otherwise fires a resize per
   pointer move.

5. **Theme.** Build the xterm theme object from the CSS custom properties already defined
   in `app.css`, read at mount and re-read on theme change, so the terminal follows
   System/Light/Dark like the rest of the shell instead of shipping its own palette.

6. **Tabs.** Tab strip with close buttons; "+" opens the shell picker built from the
   `shells` list the server returned (never a hardcoded list — on POSIX only `bash`
   exists). The "+" control is disabled with an explanatory tooltip at `max`.

7. **Lazy load.** `React.lazy` + `Suspense` around the panel so xterm lands in its own
   chunk and only downloads when the user first opens the Terminal view.

8. **Reattach.** On mount the snapshot frame carries each terminal's scrollback; write it
   into a fresh xterm instance before attaching the live stream. A page reload must look
   like the terminal never went away.

## Validation

```sh
npx vitest run web/components/workbench/terminal.spec.tsx
npm run typecheck
npm run build:web
```

Unit tests mock `@xterm/xterm` — jsdom has no real renderer, and asserting on a mocked
terminal's `write`/`onData` is honest about what it proves. Real rendering, typing echo,
colour and resize are Phase 4's Playwright job. Verify the build output shows the xterm
chunk as a separate asset, not part of the entry bundle.

## Risk / rollback

Self-contained new view. If the panel misbehaves, removing its entry from the Workbench
toolbar hides the whole feature while leaving the server surface intact and harmless.
