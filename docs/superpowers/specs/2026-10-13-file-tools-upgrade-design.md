# File tools upgrade: dedupe, pagination, ApplyPatch, spill, images

Date: 2026-10-13. Status: draft for review, revised against `main` @ `ab454a9`
(Autonomous mode, `readOnlyBash`/`riskyBash` mode properties, `finish: length`
recovery, explorer write API).
Source: comparison with ZCode v3.15.1 (`zai-org/ZCode` @ `aac4755`,
`apps/zcode-cli/packages/core/src/tool/handlers/`).

## Goal

Make the five file tools (`src/capabilities/fs/tools.ts`) cheaper on context
and more capable, without weakening the grant, observation, and approval model
they already enforce. Eight changes ship, in this order:

1. `Read` answers "unchanged" instead of repeating a window it already returned.
2. `Grep` pages with `offset`.
3. `Grep` matches across lines with `multiline`.
4. `Glob` sorts newest-modified first.
5. `Edit` tolerates escaped and unicode-escaped `old` text.
6. `Glob`/`Grep` results cut by the output cap are saved to a session file.
7. A new `ApplyPatch` tool changes several files in one verified call.
8. `Read` returns PNG/JPEG/GIF/WEBP files as images.

Success means each change has its own tests, `pnpm test`, `pnpm run typecheck`
and `pnpm run build:web` pass, and `docs/capabilities.md` describes the new
contracts.

## Out of scope

- Structured error codes (`STALE_FILE`, `AMBIGUOUS`, …). No UI or hook
  branches on the failure kind today; the model reads the sentence.
- PDF, video and notebook reading. No current need in the project.
- Edit strategies `line_trimmed` and `block_anchor` from ZCode. A fuzzy
  anchor can edit the wrong place.
- Image resizing. The harness has no image library; oversized images are
  refused with a clear message.
- Spilling `Bash` output; `BashOutput` already pages it.

## Invariants every change keeps

- Every path still goes through `resolveInGrants` and the web path-scope guard.
- A mutation still requires an observation (`assertObserved`) and the file
  lock (`withFileLock`), and re-checks containment after waiting for the lock.
- Read-only tools stay `readOnly: true`, so they keep running concurrently.
- Tool failures still surface as a failed `ToolResult`, never an exception into
  the agent loop.
- The web host (`src/web/server.ts` `hostAuthority`) and the headless bin
  (`src/bins/headless.ts` `authorityResolver`/`forceAsk`) apply the same mode
  rules; every new rule below lands in both.

---

## 1. Read: "unchanged" stub

**Problem.** Re-reading the same window repeats the whole content in context.
Subagents in long runs do this often.

**Design.**

- `FileObservations` gains a second map per session: canonical path →
  `{ hash, offset, limit, callId }` of the last successful `Read` window.
  `offset`/`limit` are the normalized values actually used.
- On `Read`, after decoding: if the session has a window record with the same
  hash, offset and limit, return
  `unchanged since your Read in call <callId>: <rel> lines <a>-<b> are identical; refer to that result. If it is no longer in your context, call Read again with fresh: true.`
- New optional argument `fresh: boolean` bypasses the stub.
- Only the session's **own** record counts. A child never stubs against its
  parent's read, because the child cannot see the parent's tool results.
- A successful `Write`, `Edit` or `ApplyPatch` drops the window record for
  that file. The hash check would already fail, but dropping it keeps the
  rule obvious.
- The record lives in memory only. A host restart forgets it, so the next
  Read returns full content.
- `exec.toolCallId` supplies `callId`. With no call id, no record is stored.
- Changes made outside the tools (Bash, the user's editor, the Files explorer's
  create/rename/delete in `src/web/project-files-write.ts`) need no hook: a
  changed file no longer matches the recorded hash, and a renamed file is a new
  canonical path with no record.

**Context builder.** `microcompactToolResults` (`src/harness/context/builder.ts`)
must not clear a `Read` result that a later stub in the same request
references. A stub is tiny, so clearing its target would leave the model with
nothing. The builder collects the call ids named by stubs (parsed from the
fixed stub prefix) and exempts those results from the candidates. If whole-turn
trimming or a compaction checkpoint removes the referenced result, the stub
text already tells the model to call `fresh: true`.

**Compaction.** When a compaction checkpoint is written for a session, the host
clears that session's window records, so no stub can point into summarized
history.

**Tests.** Stub returned on identical window; full content when the window,
hash, or `fresh` differs; no stub across parent/child; record cleared after
Edit; builder keeps the referenced result while clearing others; records
cleared on checkpoint.

## 2. Grep: `offset`

**Problem.** `head_limit` caps at 250 and there is no way to get the next page.

**Design.**

- New argument `offset` (integer ≥ 0, default 0). It skips that many units
  before `head_limit` applies. A unit is one match in `content` mode and one
  file in `files_with_matches`/`count` mode, matching the existing meaning of
  `head_limit`.
- The worker counts skipped hits and starts emitting rows after `offset`.
  Context lines of a skipped match are not emitted.
- When the run stops at the limit, the footer becomes
  `… [more matches; continue with offset <offset + shown>]` (or `more files`).
- Order is stable across calls because `searchFiles` walks directories in
  sorted name order.

**Tests.** Page 2 starts exactly after page 1 in all three modes; offset past
the end returns `no matches` plus no continuation footer.

## 3. Grep: `multiline`

**Design.**

- New argument `multiline: boolean`. When true the worker runs the regex once
  over the whole decoded file with flags `gms` (`i` added for `-i`), instead of
  per line.
- `content` mode emits every line a match spans as a `match` row (as
  `rg -U` does); `-A/-B/-C` apply around the span. One span counts as one match
  for `head_limit` and `offset`.
- `count` mode counts spans. `files_with_matches` is unchanged.
- The existing worker timeout and the 16 MiB file limit still apply.
- Zero-length matches advance `lastIndex` by one to avoid an infinite loop.

**Tests.** A pattern spanning two lines matches only with `multiline`; spans
print all their lines; zero-length pattern terminates; catastrophic pattern
still times out.

## 4. Glob: newest first

**Problem.** Results sort by name and cap at 100, so the files kept are
arbitrary.

**Design.**

- New argument `sort: 'mtime' | 'name'`, default `'mtime'`.
- After the walk, `lstat` every matched file (bounded by the existing walk
  budget), sort by `mtimeMs` descending, ties by path ascending, then cap at
  100. A file whose `lstat` fails sorts last.
- The `… [+N more matches]` footer is unchanged.
- Update the tool description to say results are newest first.

**Tests.** Newer file listed first; `sort: 'name'` keeps the old order; stat
failure does not drop the file.

## 5. Edit: escape and unicode-escape strategies

**Design.** Extend `MatchStrategy` in `src/capabilities/fs/edit-match.ts` with
two strategies tried after `quotes` and before giving up:

- `escapes`: `old` contains literal `\n`, `\t`, `\"`, `\'` or `\\` where the
  file has the real characters. Match on the unescaped `old`; unescape `new`
  the same way so the replacement is consistent.
- `unicode-escapes`: `old` contains `\uXXXX` (or `\u{X…}`) where the file has
  the character. Match on the decoded `old`; decode `new` the same way.

Both obey the existing rule that a non-exact strategy must match exactly one
place (or every place with `replaceAll`) and both add a `STRATEGY_NOTE`, so the
result says what was normalized. A strategy is skipped when `old` has no
escapes, so exact matches are never reinterpreted.

**Tests.** Each strategy matches and rewrites correctly; ambiguity is still
reported; a file that literally contains `\n` matches exactly first.

## 6. Spill oversized Glob/Grep results

**Problem.** When the 60 KB output cap cuts Glob or Grep rows, they are lost.

**Design.**

- Spill only rows that were **computed but cut by the output cap**. Rows the
  worker never produced because of `head_limit` are reached with `offset`, not
  spilled. Glob spills its full match list when it exceeds the 100-row cap.
- File: `<home>/workspaces/<workspaceId>/sessions/<sessionId>/tool-output/<executionId>.txt`,
  plain text in the same row format, written atomically, size cap 8 MiB
  (rows beyond the cap are dropped with a final `… [spill truncated]` line).
- The footer adds `… [full result (<n> rows) saved to <path>; Read it with offset/limit]`.
- **Access.** That folder is inside application storage, which tools are
  denied. `ToolExecution` gains `spillRoot?: string`, set by the host to the
  session's `tool-output` folder. `classifyTarget`/`resolveInGrants` treat a
  path inside `spillRoot` as an in-grant **read-only** target, using the same
  carve-out rule as `memoryRoots` (`grants.ts`, `hostStorageRoot`). Writes are
  refused. A child gets its own `spillRoot` and cannot read its parent's.
- Files are deleted with the session. Without a session (headless one-shot
  calls), nothing is spilled and the footer stays as today.

**Tests.** Spill written only when the cap cuts rows; footer path readable by
`Read`; `Write` into it refused; another session's spill denied.

## 7. ApplyPatch

**Purpose.** Several related edits, file additions, deletions and renames in
one call that is verified completely before anything is written, and approved
once.

### Format

Same as ZCode/Codex:

```
*** Begin Patch
*** Update File: src/a.ts
@@ optional anchor text
 context line
-removed line
+added line
*** Add File: src/new.ts
+first line
+second line
*** Delete File: src/old.ts
*** Update File: src/b.ts
*** Move to: src/c.ts
@@
-x
+y
*** End Patch
```

Paths follow the file-tool rule: relative to the workspace root, or absolute
inside a granted folder. One argument: `patch_text: string`.

### Semantics

- **Parse** with a pure module `src/capabilities/fs/patch.ts`. Errors name the
  line number. A path may appear in at most one section; a move target must not
  be another section's path.
- **Hunks.** Each hunk's old side (context + `-` lines) is matched against the
  current text with `findEditMatch(text, old, new, false)`, so hunks get the
  same normalization strategies and the same "matches N places" error as Edit.
  An `@@ anchor` limits the search to text after the first line containing the
  anchor. Hunks apply in order to the progressively updated text.
- **Preconditions.** Update, Delete, and a move source need an observation
  (`assertObserved`) and a writable encoding, exactly like Edit. Add and a move
  target must not exist.
- **Locks.** Canonicalize every target, take `withFileLock` for all of them in
  sorted order (no deadlock with concurrent Edits), then re-check containment.
- **Commit.** Compute every new byte buffer first. Then write each file with
  `replaceFile`/`createExclusive`; a delete or a move source is renamed to a
  temporary backup and removed only after every other step succeeded. If any
  step fails, restore the files already changed from their saved original
  bytes and remove created files, then fail with a per-file report of the
  final state. This is best-effort rollback, not a filesystem transaction; the
  report says so when a restore itself fails.
- **Observations.** After success, record the new hash for every written file
  and forget deleted/moved-away paths.
- **Result.** One line per file: `A path (+n)`, `M path (+a -d)`, `D path`,
  `R old -> new (+a -d)`, then numbered snippets of each updated region while
  they fit the output cap.

### Authority integration

`ApplyPatch` touches several paths, so every place that knows the mutating file
tools must learn it:

| Place | Change |
|---|---|
| `grants.ts` `targetPaths` | parse headers of `patch_text`; return every path and move target with intent `write` |
| `web/path-scope-guard.ts` | today the loop keeps only the **last** out-of-grant target. Deny a call with more than one out-of-grant path ("split the patch"); keep one-path approvals unchanged |
| `server.ts` `writesHookConfig` | true when any patch path is a hook config path |
| `server.ts` memory auto-allow (`memoryWrite`) | stays Write/Edit only; an ApplyPatch into memory still asks |
| `web/execution-authority.ts` `MUTATING_BUILTINS` | add `ApplyPatch` |
| `modes/bundled.ts` | add `ApplyPatch` to `WORKSPACE_TOOLS` (shared by Ask before changes, Edit automatically, Autonomous, Full access); never to Plan. `permissionDefaults` mirror `Edit`: `ask` in Ask before changes, `allow` in Edit automatically, Autonomous and Full access |
| `modes/known-tools.ts` | add `ApplyPatch` |
| `agents/definition-service.ts` | add to `READ_ONLY_DISALLOWED` (explorer, reviewer) and to the verifier's `disallowedTools`; add to the worker's `tools` |
| `agents/compatibility/claude.ts` | add to the Claude general-purpose tool list beside `Edit` |
| `agents/executor.ts` `filesTouched` | collect every patch path |
| `context/builder.ts` `FILE_TOOLS`, `COMPACTABLE_TOOLS` | add `ApplyPatch` |
| `mcp/config.ts` reserved names | add `ApplyPatch` |
| writer lease (`server.ts`) | lease the project folder of every target |
| `web/lib/turn-changes.ts`, tool card | show per-file changes from the parsed patch |

Approval uses the normal per-tool policy (`ApplyPatch` defaults like `Edit`),
plus one rule for deletions:

- **Patch deletions.** A patch with a `Delete File` section or a `Move to`
  (which removes its source) adds an ask requirement of a new kind
  `patch-delete` (`AskRequirement.kind` in `src/harness/tools/authority.ts`)
  unless the executing mode's resolved `Bash` permission is `allow`. The rule
  follows the mode's existing stance on deletions: Edit automatically ("shell
  commands … and deletions still require approval") asks, Autonomous and Full
  access do not, Ask before changes already asks for every patch. It is a
  property of the policy, not a mode-id check, so custom modes follow it.
  `--yolo` maps it away like other mode asks. The approval card says
  `Patch deletes or renames: <paths>`.
- **Autonomous `riskyBash`** stays Bash-only. Patch deletions name each file
  explicitly, which is the opposite of the unanalyzable bulk deletes
  `riskyBash` targets.
- **Output limit.** A model reply cut off at its output-token limit drops its
  tool calls unrun (`finish: length` recovery in `agent.ts`). The tool
  description therefore tells the model to keep one patch moderate and to
  split a large change into several calls, as the `Write` description does for
  long files.

**Tests.** Parser cases and errors; multi-file success; a failing hunk leaves
every file unchanged; rollback after an injected write failure; unobserved
update refused; Add over an existing file refused; move; delete; out-of-grant
single path asks, two paths denied; hook-config path detected; child read-only
role cannot call it; turn-changes card renders it; a delete asks in Edit
automatically and runs in Autonomous, in both the web host and the headless
bin; Plan does not expose the tool.

## 8. Read: images

**Design.**

- `Read` sniffs the first bytes with `sniffImageMediaType`
  (`src/harness/attachments/store.ts`). PNG, JPEG, GIF and WEBP become images;
  everything else keeps the text path (SVG stays text).
- The image is stored through a host callback `ToolExecution.storeImage?(bytes, name, mediaType) → AttachmentRef`
  that the web host wires to `AttachmentStore.put`. It reuses the sha256 id
  and the existing size limit. Without the callback, or over the limit, `Read`
  fails with a message naming the limit. The headless bin has no attachment
  store today, so it does not wire the callback and image reads fail there
  with that message.
- **Result shape.** `ToolDefinition.execute` may return
  `string | { text: string; attachments?: AttachmentRef[] }`. `ToolResult` and
  the `tool/result` session event gain `attachments?: AttachmentRef[]`. Text
  stays `[image "<rel>" attachmentId=<id> (<bytes> bytes)]`, so logs, hooks,
  and non-vision paths keep a readable line.
- **Projection.** `projectMessages` (`session/events.ts`) builds tool message
  content with the same helper as user attachments, so a tool message can
  carry image parts.
- **Wire.** OpenAI-compatible `tool` messages are text only. `toWireMessages`
  keeps the tool message as text and, after the last tool message answering
  that assistant step, inserts one `user` message containing the images with a
  line `images returned by tool calls <ids>`. This keeps tool-call ordering
  valid for every gateway.
- **Non-vision models.** `adaptRequestVision` already turns image parts into
  the `DescribeImage` instruction; it applies unchanged because the injected
  message is an ordinary message with image parts.
- **Budget.** Image tokens are counted by the existing history estimate.
  Microcompact clearing a `Read` result also drops its images.
- **UI.** The Read tool card shows a thumbnail from the existing attachments
  endpoint.

**Tests.** PNG read returns an attachment and the text marker; a renamed
`.png` that is text reads as text; no `storeImage` gives a clear error; wire
output inserts the user image message after the tool batch; non-vision model
gets the DescribeImage fallback; microcompact removes the image.

---

## Delivery order

Each item is independent and ships with its tests: 1, 2, 3, 4, 5, 6, 7, 8.
Items 1–5 touch only the fs capability and the context builder. Item 6 adds a
grant carve-out. Items 7 and 8 change shared types and authority wiring and
should land last. Update `docs/capabilities.md` (its file-tool table is already
stale: it still says `read` caps at 1 MB and `edit` replaces the first
occurrence) with each item.

## Risks

- **Stub hides content the model lost.** Mitigated by the builder exemption,
  the `fresh` escape hatch, and clearing records on compaction.
- **Multi-file rollback is best effort.** A crash between writes can leave a
  partial patch; the per-file report and the observation hashes make it
  visible, and the next Edit/Write refuses a stale file.
- **Glob `lstat` on many files.** Bounded by the existing walk budget.
- **Image bytes in requests.** Bounded by the attachment size limit and
  microcompact.
