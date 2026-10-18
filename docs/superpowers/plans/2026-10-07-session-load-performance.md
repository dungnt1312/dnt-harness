# Session Load Performance Implementation Plan

**Goal:** Reduce repeated session loading and avoid loading parent transcript data merely to show subagents, preserving canonical logs and existing clients.

**Architecture:** Add an opt-in delegation-only SSE projection, a bounded frontend event cache with explicit reconnect cursor, and session-safe memo derivations. First deliver these backwards-compatible optimizations; defer lazy tool outputs until all output consumers (tool facts, diff recovery, artifacts, inspectors) can preserve semantics.

**Tech Stack:** TypeScript, React, Node HTTP/SSE, Vitest, Playwright Chromium.

## Constraints
- Never alter canonical logs for UI optimization.
- Never deploy/restart production or send messages to real sessions.
- Keep existing SSE clients and automatic reconnect working.
- Bound cached session data; cached approvals/questions are not authoritative.
- Profile real history without storing transcript bodies in artifacts.

## Review Focus
- A fresh snapshot after cursor rejection replaces state rather than appending.
- Server cursor includes omitted events, even when a filtered replay is empty.
- Workspace/session/filter cache keys cannot collide.
- Live events buffered before session switch are not lost or duplicated.
- Switching between sessions with equal type counts must invalidate derived state.

### Task 1: Filter parent stream
Files: src/web/server.ts, web/lib/api.ts, web/hooks/useSessionStream.ts, web/App.tsx, tests/web/session-load-performance.spec.ts.
- [ ] Write failing real-server tests for delegation-only replay/live and unchanged default replay.
- [ ] Run tests and inspect expected failure.
- [ ] Implement `view=delegations` for parent stream, preserving SSE latest cursor.
- [ ] Run tests and typecheck.

### Task 2: Bounded cache and cursor resume
Files: web/lib/session-stream-cache.ts, web/hooks/useSessionStream.ts, web/lib/api.ts, web/lib/types.ts, src/web/server.ts, frontend tests.
- [ ] Test bounded LRU cache, scope keys, oversized admission, replacement and resume.
- [ ] Observe failures before implementation.
- [ ] Cache compacted events only, maximum 3 sessions / 32 MiB estimated retained data; restore projection when revisiting and subscribe with explicit cursor.
- [ ] Reset compactor on fresh snapshots and publish frame cursor independently of retained event sequence.
- [ ] Verify empty replay and duplicate suppression with mounted hook tests.

### Task 3: Session-safe derived scans
Files: web/lib/session-derived.ts, web/components/chat/Transcript.tsx, tests.
- [ ] Test gates across equal-count snapshot replacements and unrelated chunks.
- [ ] Observe failures, implement session-safe gate identity and memoized derivations.
- [ ] Run targeted tests, full suite, typecheck/build.

### Task 4: Real profile and handoff
- [ ] Run isolated frontend against existing host via Vite proxy; read-only browser API guard.
- [ ] Compare same real root/child sessions and A→B→A using snapshot bytes, long tasks and render readiness; report environment limitations.
- [ ] Review changes and report remaining lazy output/cold backend work explicitly.
