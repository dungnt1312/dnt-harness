# Task 5 report: chat-workflows Playwright e2e

Status: DONE_WITH_CONCERNS. `tests/browser/chat-workflows.e2e.ts` passes 52/52 (`bunx playwright test ... --timeout=30000`, 1.9 min). No server lingers on 4175.

Commits (pushed fast-forward to origin dev, cf8275d..9a25e35):
- 84d6549 fix(web): give the settings skill, memory and role lists valid ARIA structure
- 9a25e35 test(browser): bring the chat-workflows e2e up to the current settings and workbench UI

## Baseline
19/52 failed at cf8275d (the two "advanced limits draft" cases already passed). Causes, all fixed:
- Rail renamed "Providers & Models", sections now Providers & Models, Usage, Advanced, Projects, ...: exact tab/option names; ArrowDown from Providers lands on Usage. Added `/api/usage` mock. Nav test scroll check now uses Advanced (Hooks panel no longer overflows). Test name no longer claims "nine" (14 sections exist; only the 10 whose endpoints are mocked are walked, Permissions/System Prompts/Plugins/Sources are not).
- Projects removal is a row menu ("Actions for Fixture project" > Remove project).
- Hooks API is Claude Code format now: mock returns HooksConfigRow, raw editor is "Edit raw JSON" / `"hooks"` / "Apply JSON" / "Save changes", PUT body `{hooks, disableAllHooks}`. Invalid cases rewritten (non-object, unknown event, non-command type).
- Agents: role is an option, "Delete" then "Delete role". Memory save is "Save entry". Screenshot matrix skill flow: open skill, "Edit raw", SKILL.md textbox.
- `agents/children` mock moved out of the settings-only block (delegation fixture hit it). Delegation "Open conversation" lives in the Workbench region.
- Tool row accessible name is "Open <path> in workbench"; markdown opens in Preview so the test switches to Code, finds the CodeMirror textbox and asserts `.cm-scroller` scrollTop > 0.
- Running-session manifest: product now fetches once (context meter) by design (manifest-refresh.ts); test asserts exactly one read, not zero.
- Composer mode trigger renamed "Conversation mode (follows the workspace default)".
- Coarse-pointer: composer controls are 36px by documented opt-out (`data-compact-control`, app.css); test asserts 36 for composer, 44 elsewhere (header, approval, workbench, settings still 44).

## Real UI bugs fixed (axe, found once the settings walk reached them)
- SkillsPanel / MemoryPanel tree: group header buttons were bare children of a tree group (axe aria-required-children), skill button used aria-selected (aria-allowed-attr). Header is now role=treeitem, skill files sit in a role=group, open skill uses aria-current.
- AgentsPanel: collapsible header button sat inside role=listbox. Each layer is now group(aria-label) > header button + listbox of options.
- Unit tests: agents-panel-roles.spec.tsx (new), memory-panel.spec.tsx, skills-panel.spec.tsx. RED confirmed with the product files stashed (agents and memory fail; skills test is also added). settings-panels.spec.tsx selector updated for the new group nesting.

## Verification
- `bun run typecheck` clean; `bun run build:web` ok.
- `bun run test --maxWorkers=3`: 5126 passed, 1 failed (settings-panels agents group selector, fixed after); `vitest run web/components/settings` 230/230 after the fix. Full suite not re-run end to end after that last one-line selector fix.

## Concerns
- Hooks `validateHooksSection` rebuilds entries and silently drops unknown keys (`if`, `async`, `asyncRewake`, extra fields) on raw Apply/Save, although the effective-row model supports them. Likely data loss when saving from the UI; not touched (outside this task). Worth a follow-up.
- Markdown files read via a tool row open in Preview, so the recorded line window is only honoured in Code view. Test adapts; product behavior left as is.
