# Code review — claude-style subagents (phases 0–6)

Reviewer: code-reviewer subagent (read-only; no shell). Verdict: DONE_WITH_CONCERNS. Findings and disposition after fixes:

| # | Finding | Disposition |
|---|---|---|
| H1 | New bundled `reviewer`/`verifier` shadow existing workspace files of the same name | Kept the 4-role decision. `list` now warns about a shadowed file; `delete` removes a shadowed file (bundled role itself still undeletable). Live data had no custom roles. Test added. |
| M1 | Recovery/reconstruct accept a child the parent never recorded | Fixed: both require the parent's `agent/child-spawn` for that child (the commit point). Test added. |
| M2 | Reconstruct reads "no record, no turns" as `completed`; spawn-window race | Fixed: without a parent terminal record only a last `turn/end: completed` reads completed, else `interrupted`. Child enters the active map as soon as its session exists, so the window lists `running`. Tests added. |
| M3 | Evicted children re-digested on every poll; N+1 parent reads | Fixed: bounded settled-handle cache (256, oldest out); `childrenOfRoot` reads the root log once and shares it. |
| M4 | Deleting an idle root left HTTP-spawned children running | Fixed: both delete routes cancel the root's children first. Test added. |
| M5 | `findSession` registered child sessions as roots (would make the lease turn-held for a child) | Fixed: child sessions are viewable but never join the root registry. Messages to them stay 409. Agent object creation for viewing remains (never runs). |
| M6 | No concurrent-spawn test | Existing "four simultaneous spawns" test already covered one root; added two-root concurrent test. |
| L1 | Preamble change alters root wrapped content | Intended by phase 4 (shared preamble names `parent-context`); plan criteria reconciled in notes. |
| L2 | Trim-order comment stale | Fixed. |
| L3 | `findSession` lost its doc comment | Fixed. |
| L4 | HTTP route normalization differs from tool | Fixed (trim/filter). |
| L5 | Workbench drops objective silently when brief set | Kept: the field hint says the objective is used only when the brief is empty. |
| L6 | Weak ceiling test; mojibake | Mojibake pre-existing (not in diff). Gate denial covered in `server-g4`. |
| L7 | Cut oldest inherited message loses its prefix | Accepted, cosmetic. |
| L8 | Recovery project check only with `projectId` | Accepted: children written by this build always carry it when bound. |
| L9 | Child agents never forgotten | Fixed: `finish()` forgets the child agent once its record is durable. |

Verification after fixes: `npm run typecheck` 0 errors; `npx vitest run` 931 pass / 10 fail — the 10 (workspace-isolation ×1, session-model ×3, composer ×6) fail identically on the pre-change baseline. `npm run build:web` ok; pm2 `mini-dsh` restarted, online, bundled roles live = explorer, worker, reviewer, verifier.

Unresolved:
- 10 pre-existing unit failures and Playwright `chat-shell` setup failure (`GET /api/auth/state` missing from the fixture) belong to the auth/MCP work, not this plan.
- Untested by construction only: mid-run definition edits (instructions pinned in scope), message appended after spawn (snapshot taken synchronously).
