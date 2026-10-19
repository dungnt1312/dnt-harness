# Task 7 report: deferred fixes (incl. hooks data loss)

Status: DONE_WITH_CONCERNS (concerns at the end). Branch `dev`, 41830d0 → 3ababf1, pushed fast-forward. PR #1 runs green on 3ababf1.

## Commits (oldest first)

| SHA | Item | Subject |
|---|---|---|
| d8f8ca8 | A | fix(hooks): keep hook fields the settings editor does not understand on save |
| d80d7b0 | plan 1 | refactor(agents): resolve a child's current run once during boot recovery |
| 1382f28 | plan 2 | test(mcp): require exactly one live stdio process after each reconnect |
| cfce259 | plan 3 | docs(mcp): note that the audited result hash covers the model-visible text |
| d33d815 | plan 4 | fix(speech-to-text): answer 413 for audio over the attachment limit |
| 8f869fc | plan 5 | docs(plans): scope the PM2 drill result to the direct MCP child |
| a2ef4f1 | B + C | docs(terminals): describe the session rescan that macOS now shares with Linux |
| ca7a977 | D | test(terminals): prove each macOS probe leg's own shell starts as a login shell |
| 252f519 | E | test(pm2): count the Windows leftover-shell check against the pm2 kill budget |
| 7c67c92 | F | ci(windows): match the headless chat reply on stdout alone |
| d3af069 | G | test(browser): hold only marked compact composer controls to the 36px target |
| 1e8a321 | H | test(prompt): stop the absence scorer failing negated mentions and lines of a file cited earlier |
| 728bbce | CI flake | test(compaction): skip a torn last line while polling the event log |
| 3ababf1 | CI flake | test(hooks): end the scripted turn after one tool step in the PostToolUse audit test |

No Co-Authored-By trailer, per constraints.md.

## A. Hooks settings data loss (must-fix)

Cause: two layers both rebuilt hook objects from the fields they model.
- Client `validateHooksSection` (`web/components/settings/HooksPanel.tsx`) kept only `type/command/timeout` per command and `matcher/hooks` per group. The form Save and the raw-JSON Apply both go through it, so `if`, `async`, `asyncRewake`, `rewakeMessage`, `rewakeSummary` and any newer Claude key were dropped.
- Server `readWorkspaceHooks` / `writeWorkspaceHooks` (`src/harness/hooks/settings.ts`) used `parseHooksSection`, which keeps the five Claude modifiers but drops every other unknown key. So a GET then PUT round trip still lost data even with a fixed client.

Fix: both sides copy unknown group and command fields through untouched. Known fields are still validated: the client validates type/command/timeout, and the server's strict parse validates those plus the modifiers. On the server this is opt-in (`preserveUnknown`), used only by the editor read and write paths. Runtime hook loading is unchanged. `HookCommandRow` and `HookMatcherGroupRow` in `web/lib/types.ts` gained an `unknown` index signature.

TDD:
- RED (before fix): `bunx vitest run web/lib/product-ui.spec.tsx tests/harness/g5-hooks.spec.ts -t "untouched|round trip|malformed known"` → 3 failed, 1 passed. Failing: the form-save test, the raw-apply-save test, and the server read→write round trip. The diff showed `async`, `asyncRewake`, `if` and `future` missing from the saved body. The 4th test (malformed known field still rejected) passed both before and after.
- GREEN: the same tests, plus all of `web/components/settings` → 20 files, 439 passed. Typecheck clean.
- New tests:
  - `web/lib/product-ui.spec.tsx`: "hooks editor saves fields it does not understand untouched" (mounted panel; edits the matcher, saves; asserts the `saveHooks` body) and "hooks raw editor applies and saves fields it does not understand untouched".
  - `tests/harness/g5-hooks.spec.ts`: "workspace hooks round trip": read→write keeps unknown and modifier fields, and a malformed known field still throws.

## Plan items

1. `executor.ts` boot recovery: `currentRun` is now computed once per child, after the `parentEvents === undefined` early continue. Subagent suites (g4-agents, g4-subagent-contract, subagent-background/resume/stability): 130/130.
2. `tests/web/mcp-runtime-reconciliation.spec.ts`: asserts `toHaveLength(transport === 'stdio' ? 1 : 0)` using the stored config, replacing `≤ 1`. Passed 7/7 three times in a row.
3. `src/web/server.ts`: added a comment that `resultHash` hashes the model-visible text, meaning the truncated output plus any in-flight config-change note.
4. Speech-to-text oversize: returns 413. A declared `Content-Length` over `maxAttachmentBytes` is refused without reading the body. An overflow while reading (`AttachmentError`) also maps to 413, and other failures stay 502. RED: the new test failed with `SocketError: other side closed`, because the old path destroyed the request and the client did not even get the 502. GREEN: `tests/web/server-speech-to-text.spec.ts` 5/5, three runs. `docs/web.md` now documents the 413, including that a chunked overflow may show up as a closed connection instead. The client (`transcribeSpeech`) already surfaces the server's `error` text.
5. PM2 drill checkbox in `phase-06-process-ownership-and-resource-policy.md`: scoped to "no host and no direct stdio MCP child", with "grandchildren not drilled". The Scope sentence was reworded to match. No re-drill.

## Addendum B–H

- B/C: in `src/web/terminals.ts`, the `remaining()` doc, the pre-close snapshot comment and the `sessionView` doc no longer describe the tty model. The seed comment now says macOS `lstart` is not numeric, so macOS membership rests on getsid(2). Comments only.
- D: `scripts/pty-probes.mjs`: each leg now opens its own shell (`shellId: shellName`) and checks login mode. It also checks that the default terminal is still the catalog's first entry. Local: zsh 11/11, bash 11/11. CI macos-15 ([run 39188610366](https://github.com/dungnt1312/dnt-harness/actions/runs/39188610366)) shows `shell=zsh /bin/zsh -l -i login=true default=bash first=bash`, so zsh login is now proven on the runner even though its account shell is bash.
- E: `scripts/pm2-smoke-windows.mjs`: the survivor wait is now `started + 15 s - now`, inside the pm2 budget. The check name says "within 15 s". CI: restart and stop both show `survivors: none`.
- F: `.github/workflows/windows-smoke.yml`: stdout is captured alone (`2> chat-stderr.txt`) for the `e2e-plain-ok` match, and stderr is printed under its own header. CI log: `--- stdout --- e2e-plain-ok --- stderr ---`. The job is green.
- G: `tests/browser/chat-workflows.e2e.ts`: composer `button[data-compact-control]` ≥ 36, other composer buttons ≥ 44, and at least one compact control must be present. The failure message carries the element's HTML. Whole file: 52/52 passed.
- H: prompt eval absence case, `ocproxy-2`, `deepseek-v4.1-flash-free`. The key was read from `~/.dnt-harness/providers.json` by an inline `bun -e` launcher and passed only in the child env. It was never printed or written.
  - Run 5 (capture copy of `run.ts` in the scratchpad, identical except that it writes the final answer to `scratchpad/eval/answer-N.txt`): **0/5 pass**. All 5 hit "attributes a location to the nonexistent symbol", and 3/5 also hit "cites an invented location". Recall was 1/1 each, 4–5 calls, 0 duplicates.
  - Classification: **5/5 scorer false positives, 0 real mis-attributions.** Every answer states the absence (e.g. "There is no `fraudScore` validation in this project") and cites only real lines of the 9-line `src/orders/validate.ts` (1, 3, 3–9, 5, 6, 7).
    - The attribution rule fired on sentences where the symbol mention was negated (the interface has no such field; a search for the name found no matches).
    - The invented rule fired on a bare "(line N)" whose file was named in the previous sentence.
  - Fix in `scripts/prompt-eval/score.ts`:
    - A mention directly preceded by "no/without", or followed by "returns no matches/nothing", claims nothing, unless the sentence has a contrast word (but/except/however/although/though).
    - A bare "line N" is checked against the most recently cited file, and is still invented when no file was cited.
  - Tests in `tests/scripts/prompt-eval-score.spec.ts`: the real sentences as a passing case (RED before the fix, GREEN after), plus new negative cases (negation + "but"/"except", a bare line before any file, a bare line past the end). All earlier hardening tests are unchanged and pass, 23/23. Re-scoring the 5 captured answers: 5/5 pass.
  - Run 6 (official `run.ts`, fixed scorer): **5/5 pass**, 4–5 calls, 0 dup. These answers were not captured.
  - Recorded in `plans/261017-runtime-provider-hardening/reports/phase-06-final-report.md` (QH-2 row, runs 5 and 6, classification paragraph, pending item 5), `plan.md` and `phase-06-metrics-docs-release.md`. Product base prompt unchanged. Captured answers stay in the scratchpad only and were never committed.

## Verification

- `bun run typecheck`: clean (re-run after every code commit).
- `bun run build:web`: built.
- `bun run test --maxWorkers=3` (local, macOS, at 1e8a321): 374 files, 5155 passed, 2 skipped, exit 0.
- `bun run test:browser tests/browser/chat-workflows.e2e.ts`: 52/52.
- CI on 3ababf1, all green:
  - Linux full suite [39189450694](https://github.com/dungnt1312/dnt-harness/actions/runs/39189450694)
  - Runtime probes [39189450722](https://github.com/dungnt1312/dnt-harness/actions/runs/39189450722)
  - Windows smoke [39189450640](https://github.com/dungnt1312/dnt-harness/actions/runs/39189450640), green after one failed-job rerun (see concerns)

### CI flakes found while pushing (root-caused, fixed test-side)

- 1e8a321 Linux [39188610445](https://github.com/dungnt1312/dnt-harness/actions/runs/39188610445): `compaction-benchmark.spec.ts` `JSON.parse` on a torn last line of `events.jsonl` that the server was still appending. The poll now skips an unparseable line (728bbce). Passes locally 5/5.
- 728bbce Linux [39189050872](https://github.com/dungnt1312/dnt-harness/actions/runs/39189050872): `server-g5.spec.ts` "PreToolUse blocks Bash…" saw 2 PostToolUse audits. Its scripted provider returned tool calls on every request, so under load a second step ran before the poll/stop. The provider now returns a final answer after the first step (3ababf1). Passes 3/3 locally. This is unrelated to item A: no unknown keys are involved, and the runtime parse is unchanged.

## Concerns

1. Windows smoke on 3ababf1 first failed `pty-smoke-windows` "powershell: input → output", which has a 5 s budget. That step and script were not touched. It is the first failure in 13 runs, and the failed-job rerun passed. I treat it as a runner load flake and did not change it.
2. Item A scope: the server's lenient GET still drops whole entries it cannot run (e.g. a `type: "prompt"` hook, or an invalid modifier). The UI shows those as "Skipped entries", and a save from the editor then removes them from the workspace file. Only unknown *fields* were in scope. Removing whole skipped entries on save is a related data-loss path, and fixing it would be a product decision.
3. Item H: the scorer was adjusted after seeing live answers (as in run 1). Run 6 answers were not captured, so the 5/5 pass rests on the scorer alone. All evidence is one model via one proxy.
4. The PM2 grandchild case is documented as not drilled, not proven.

---

# Fix round 1

Status: DONE. Pushed fast-forward 3ababf1 → b7f7aa0. PR #1 runs green on b7f7aa0: Linux full suite [39191764748](https://github.com/dungnt1312/dnt-harness/actions/runs/39191764748), Runtime probes [39191764707](https://github.com/dungnt1312/dnt-harness/actions/runs/39191764707), Windows smoke [39191764717](https://github.com/dungnt1312/dnt-harness/actions/runs/39191764717), all green on the first attempt.

## Commits

| SHA | Item | Subject |
|---|---|---|
| c90fd45 | 1 | fix(hooks): keep hooks and events dnt-harness cannot run through a Settings save |
| 8280b71 | 2 | test(prompt): count a found-nothing clause as negation only after a search for the symbol |
| 8d3c557 | 3 | test(terminals): wait for the Windows shell prompt before typing in the PTY smoke |
| b7f7aa0 | 3 | test(terminals): detect the Windows shell prompt itself rather than a pause in output |

## 1. Hook entries the server cannot run are no longer lost

Cause:
- The editor GET returned the lenient runtime parse, which skips non-command hooks and unknown events.
- The PUT then rewrote `doc.hooks` from what the client sent, so the skipped entries were deleted.
- A prompt-only group came back as `{hooks: []}`, and the empty-group check blocked Save.

Approach: the entries round-trip through the client in their own positions. I did not build a server-side merge, because group indexes shift whenever the user adds or removes groups, so a merge cannot map entries back to their places reliably.
- Server (`src/harness/hooks/settings.ts`):
  - `readWorkspaceHooks` returns the workspace `hooks` section as written. A non-object section is a 400 rather than an empty view.
  - New `validateEditorHooks` is used by `writeWorkspaceHooks`. It validates command hooks strictly, through the shared `parseCommandHook` the runtime parser also uses.
  - It keeps the following verbatim and in place: unknown events, hooks of any other `type`, and unknown group or command fields.
  - It still rejects malformed structure: non-array known event, non-object group or hook, non-string matcher, missing or non-string `type`, and bad command, timeout or modifier fields.
  - Event key order is preserved.
  - The runtime parse is unchanged; the `preserveUnknown` option added in A was removed as no longer needed.
- Client (`HooksPanel.tsx`, `types.ts`):
  - `validateHooksSection` mirrors the server rules. Non-command hooks become `KeptHookRow` and unknown events pass through.
  - Kept hooks render read-only in their group position (`.hooks-kept`, type badge, "not run · kept"), with no remove button; the raw JSON is where to change them.
  - Command edits address the hook by index, so kept neighbours stay where they are.
  - `commandMissing` now only looks at command hooks. A group of only kept hooks no longer blocks Save, and the empty-group block is gone.
  - New notice for unknown events kept in the workspace file.
  - The "Skipped entries" notice now reads "Not run by dnt-harness, kept in their files as written: …".
- `docs/claude-format.md` describes the save rule.
- Changed existing contract: the raw editor and `validateHooksConfig` used to reject unknown events and non-command types. These tests now assert that such entries are kept:
  - `management.spec.tsx`
  - two `product-ui.spec.tsx` raw cases
  - two `chat-workflows.e2e.ts` raw cases

  The rejection cases were replaced with input that is still invalid: an event value that is not an array, and a hook without `type`.

TDD: RED with 5 failing tests, GREEN after the fix.
- (a) A prompt hook beside a command hook: the command is edited and saved, and the prompt hook stays unchanged at index 0. Covered by a server round-trip test and a mounted-panel test.
- (b) A group holding only an `agent` hook: Save is not blocked, and the save body or file is unchanged. Server and mounted-panel tests.
- (c) An unknown event (`FutureEvent`) survives a save, with key order kept. Server and mounted-panel tests.

## 2. Scorer: "returns nothing" anchored to a search

"Returns no matches/nothing" now negates a mention only when the mention is the object of a search verb (search, grep, look, query, optionally followed by "for"). RED: added the sentence "…fraudScore is computed at line 5 and returns nothing for valid orders." as a must-fail case; it failed (passed the scorer) before the change. GREEN: 23/23. The 5 captured live answers still re-score 5/5 pass.

## 3. Windows PTY smoke: wait for the prompt

The fixed 1.5 s sleeps before typing (per shell, before the background-job command, before the 5× `exit`) were replaced with `shellReady`. It strips escape and control sequences and waits, bounded to 20 s, for output ending in `>`, `$` or `#`.

My first version (8d3c557) waited for "first output, then 300 ms quiet". On CI it reported every shell ready at about 355 ms, which means ConPTY's initial sequences tripped it before the real prompt, so I replaced it with prompt detection. With prompt detection, CI shows bash 867 ms, **powershell 2190 ms**, cmd 51 ms. So the old 1.5 s sleep really was too short for PowerShell on that runner. 14/14 PTY checks, 27/27 pm2 checks.

## Verification

- `bun run typecheck`: clean.
- `bun run build:web`: built.
- Covering specs passed: product-ui, settings, g5-hooks, server-g5, hook-background and prompt-eval-score.
- `bun run test --maxWorkers=3` (local, at 8d3c557): 374 files, 5160 passed, 2 skipped, exit 0.
- `bun run test:browser tests/browser/chat-workflows.e2e.ts`: 52/52.

## Concerns

- A command hook that the runtime skips for an invalid field (e.g. `if` on `Stop`) now reaches the editor as written. Saving is refused with the server's message until it is fixed or removed. Nothing is lost, but every save is blocked until then. Before this change it was silently deleted.
- A typo'd `type` (e.g. `"comand"`) is now kept and shown as "not run · kept" instead of being rejected.
