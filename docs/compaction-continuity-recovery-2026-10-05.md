# Compaction continuity recovery — session-muth6xq0uluol5 (2026-10-05)

## Status

- Implementation: Tasks 1–3 complete; per-task suites and the whole-change review (including the P2 empty-fallback fix) are green.
- Recovery: **BLOCKED at Step 3** — needs approval to restart the running web server (see below). Backup (Step 2) is complete and verified.

## Runtime findings (read-only)

- The web server listens on loopback :3082, PID 88780, started 12:33 today — it runs the **pre-fix code**. Restarting it would also interrupt the currently active conversation/agents, so per the approved plan the recompact is left pending until the operator approves a restart.
- The target session is bound to workspace `ws-mur65pzr745ftn`; the live log is
  `~/.dnt-harness/data/workspaces/ws-mur65pzr745ftn/sessions/session-muth6xq0uluol5/events.jsonl` (9,128,274 bytes). Checkpoints are keyed under `~/.dnt-harness/data/workspaces/<session-id>/checkpoints/`.

## Step 2 — backup (done)

- Backup directory: `~/.dnt-harness/backups/session-muth6xq0uluol5-20261005-134205/`
  (contains `events.jsonl` and `checkpoints/46868.json`)
- Original log prefix: **9,128,274 bytes**, SHA-256
  `d6f570e72a4f8cf43c00f1c2390a72b16fe01370baf81720e2dac900bb290629`
- Verified after copy: live log byte count unchanged; nothing under `~/.dnt-harness/data` was modified or deleted.
- The stale checkpoint (coversSeq 46868, 5,024-char summary missing the latest state) stays in place until a successful recompact publishes a newer one.

## Step 3 — recompact (blocked, how to run)

After the operator approves a server restart (or a second server instance is started on another port pointing at the same data home):

1. Restart `npm run web` (port 3082) so the fixed summarizer/window code loads.
2. `POST /api/workspaces/ws-mur65pzr745ftn/sessions/session-muth6xq0uluol5/compact` once.
3. Expect 200 with a new `coversSeq` (≥ 46868) and a larger `summaryChars`; a failed attempt surfaces a 409 and leaves the previous checkpoint intact (covered by tests).

## Step 4 — validation checklist (pending Step 3)

- New summary retains pre-compact state: commit `44f6ada`, `60 suites / 1.204 tests`, Phase 3/media runtime status, and the four pending items (browser audio acceptance, media smoke automation, production secret rotation, flake monitoring). Later in-session claims do not retroactively prove those items were resolved.
- Original JSONL is still a byte-identical prefix (compare against the backup hash above); no user message appended.
- Offline context build against the new checkpoint shows the covered raw tail plus the trusted continuation line.
- No automatic follow-up message is sent to the session; the user decides what to ask next.

## Verification scope

- Local wire preservation of the two system blocks (base + wrapped compaction) is proven by the adapter test in `tests/harness/llm-openai.spec.ts`.
- Whether the external gateway forwards and the model uses the summary block remains **unverified**; the earlier "new session" answer is not yet fully explained. If it recurs with a correct summary in place, investigate the gateway next.
