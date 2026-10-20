# Task 9 report

Status: DONE

## Browser specs (24 failures -> 90/90 green, run twice in full)
No shared fixture exists; each spec carries its own route table. Root causes, all stale test mocks/selectors (no product bug):
- Missing boot-time mocks: `/api/model-aliases`, `/api/speech-to-text`, `/api/workspaces/w/commands` (attachments, chat-shell, terminal, trajectory).
- Git status mock lacked `branchInfo`/`head` (contract requires null); GitPanel crashed ("Something broke in the interface") on undefined. Mocks now send `null`. The contract is typed non-optional in web/lib/api.ts, so no product change.
- File viewer is now a CodeMirror textbox: `region "Contents of ..."` -> `textbox`.
- Settings tabs: `Providers & Models` exact names (control-plane-auth).
- Terminal panel auto-opens its first terminal: replaced the obsolete "No terminal open" wait with the auto-open POST poll.
- Trajectory: tool row is now "Search Find createProject in src"; output is the expanded body and arguments sit behind "View call details" (`pre[aria-label=Arguments]`); Subagents region is "Active subagents" / "Active · 1".
- Attachments lightbox backdrop click raced the dialog becoming interactive; now waits for the Close button to hold focus (deterministic in 3 isolated + 2 full runs; failed every full run before).
Terminal "No terminal open" test and lightbox looked load-flaky at first; both were deterministic and fixed.

## Commits (all pushed to origin dev, fast-forward)
- 6950db7 test(browser): bring the remaining e2e specs up to the current shell, workbench and settings UI
- efbc3c6 docs(readme): make the macOS probe run text match its link
- docs(release): point the checklist evidence at the runs on the current head (see git log)

## Evidence (head efbc3c607775697ffe9768b7b2a483031b18dcf3; code-identical to d4a986f apart from tests/browser and README)
Verified with `gh run view <id> --json conclusion,headSha`, all success:
- Linux full suite 39198490517
- Runtime probes (linux-probes + macos-pty-probes) 39198490537
- Windows smoke 39198490618
- Release dry run 39198490636 (publish skipped)
Checklist/README links updated; the older historical macOS run 39177692003 (11/11 both shells) is intentionally kept as such. CHANGELOG cites no run ids. The docs commit becomes the new head; runs are on the previous head efbc3c6.

## Checks
`bun run test:browser` 90 passed (x2 full, plus isolated runs); `bun run typecheck` clean. No product code changed, so full vitest was not rerun locally (CI Linux suite green on efbc3c6). CI does not run test:browser. No servers left running by me.
