# ZCode vs dnt-harness: compaction performance

## Evidence scope

Read local ZCode clone `/private/tmp/zcode-research`, commit `aac4755666d09fdcd70272fcf063c077a639015f`. This is a pinned local snapshot, not verified latest upstream. Read current dnt-harness source. No implementation edits or live ZCode benchmark.

## Architectural difference

ZCode summarizes active runtime history, not the original full event transcript. `runtime/methods/compact-active.ts:186-202` snapshots `messageHistory.borrowReadOnlyRuntimeEntries()` or the active turn entries, then selects the summary/preserved portions. `compact-active-helpers.ts:80-93` renders these structured messages with an appended user compaction prompt, cache control enabled and cache writes skipped. `compact-active.ts:387-414` submits that request with an explicit summary output budget. There is no sequential full-transcript chunk fold in this path.

ZCode runs microcompact before auto compact on each model step (`runtime/methods/turn-loop.ts:77-101`). Microcompact changes active runtime entries (`runtime/helpers/compact.ts:105-159`) by replacing eligible old tool results with placeholders. It keeps five recent eligible result groups, not five per tool (`compact/microcompact.ts:125-137,201-242`); error results are protected by default and media results are excluded. Manual compact does not itself invoke microcompact in `executeManualCompact`, but operates on the current history, which may already contain cleared results.

After success, active history is replaced (`compact-active.ts:625`), using prefix + summary + preserved entries + reminders (`runtime/helpers/compact.ts:72-87`). Manual preserves zero recent rounds; auto/reactive normally preserve one assistant-started round (`compact-selection.ts:30-57,209-225`).

If the summary input exceeds context, ZCode can preserve additional recent rounds for auto/reactive and/or drop oldest summary rounds with bounded retries (`compact-selection.ts:59-139,167-207,279-334`). This knowingly sacrifices source coverage; it is not equivalent to dnt-harness's full-source fold guarantee.

## dnt-harness mismatch

The ordinary request builder microcompacts tool results (`src/harness/context/builder.ts:610-616`), but fallback compaction calls `projectForSummary` on committed original events beyond the seed (`src/harness/context/compaction.ts:239,276-284`). This reconstructs raw tool results cleared in request projection and flattens structured messages to text. The 200,000-character chunker then folds sequentially (`src/web/llm-summarizer.ts:141-198`).

Cache-aware compaction exists but is gated by a serialized 200,000-character prefix limit (`src/web/server.ts:1359-1361`). In addition, any context omission disqualifies the completed request prefix (`server.ts:3210-3218`). Thus microcompaction can prevent using precisely the effective bounded request that ZCode would summarize.

## Recommendation and trade-offs

The primary change should be the summary source contract, not merely larger chunks: summarize a committed effective structured context with preserved stable prefix, append the compaction instruction, and use one logical summary call in the normal case. Treat the event log as durable audit data, not mandatory full-source input for every summary.

Keep dnt-harness's canonical checkpoint, completed-boundary validation, transactional durability, incremental recovery, and bounded verbatim user retention. Do not remove its omission gate without defining eligible omission classes: intentional tool-result clearing is different from missing user messages, excluded history or arbitrary trimming. A persisted effective projection is needed for restart/resume; the current completed-request map is host-memory-only.

Do not copy ZCode's oldest-round dropping silently: it conflicts with current full-source summary coverage expectations. Specify incomplete coverage or fail safely when no prior effective projection/summary covers important omitted facts. Decide separately whether full-history archival summarization remains available as a slow explicit operation.

Output-prompt reduction and larger chunks are secondary optimizations. No measured latency promise is justified until a normal single-request path is benchmarked on the configured providers.

## Corrections to earlier review

The observed provider inputs were about 80–90k tokens/request, not a verified 50k. Input represented roughly 40–45% of a hypothetical 200k window, not less than one quarter. Zero gaps between successful usage records do not establish zero failed attempts inside a buffered request; usage records only account for completed usage-bearing attempts. Cache-aware rejection due to omissions is an additional gate beyond prefix size. Existing earlier research's statement that ZCode keeps five results per tool is contradicted by this snapshot: retention is across eligible result groups.
