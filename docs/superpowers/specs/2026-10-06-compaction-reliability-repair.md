# Compaction reliability repair

## Intent and scope

The user approved repairing the defects reported in the compaction audit: completion validation, canonical projection and attachments, safe checkpoint publication and concurrent admission, effective tail configuration, and automatic triggering. Success means a successful compaction preserves covered task information and is actually consumed by the next request; unsuccessful attempts never authorize history replacement.

This is an architectural repair of the existing compaction flow, not a new summarization subsystem. Approved by the user on 2026-10-06: proceed with the proposal without additional confirmation.

## Constraints

- Preserve unrelated dirty changes. Do not commit, restart a live server, invoke paid/live providers, modify live checkpoints, or send live follow-up messages automatically.
- Preserve the existing JSONL prefix and same-session identity. Summary is lower-trust reference data, never promoted to memory.
- Retain chronological folding of every source character, 200,000-character input request envelopes, and 24,000-character output summaries. Input limits are not token-window guarantees.
- Preserve the compact endpoint response shape and decode existing lifecycle/checkpoint formats without inventing missing provenance.
- Keep compaction at completed boundaries. Do not rewrite an active turn to recover context pressure.

## 1. Summary admission and completion

Use the existing completion validator and provider admission/lifecycle facilities rather than another retry/timeout runtime. Each summarizer request must have one valid settled completion with finish reason stop, no tool-call output, and nonempty bounded answer text. EOF alone, unsuccessful finishes, unresolved cleanup, duplicate completion or output after completion must fail. Explicit legacy completion remains permitted only through the existing declared compatibility adapter.

Pass session attribution and cancellation/deadline ownership through summarizer requests. Stop/delete/shutdown must cancel owned work and must not publish a new checkpoint after cancellation. Bound each summarizer logical request using existing configured first-event, idle and total deadlines; retain streaming output limits. A multi-chunk failure publishes no partial summary.

The compaction core independently validates source and summary bounds so a custom Summarizer cannot bypass the contract.

## 2. Canonical projection and attachments

Reuse the canonical effective-call projection for both dated context history and summary projection. Preserve event sequence information for history windows without duplicating tool rewrite semantics. Summary source includes text attachment content under the same bounded loading policy as ordinary context and explicit image/file references. Missing content is disclosed; never imply an image's unseen pixels were summarized. Covered tail and uncovered history preserve tool-call/result pairing.

## 3. Transaction and checkpoint eligibility

Serialize manual and automatic compaction per session, including PreCompact hooks and snapshot admission. Concurrent manual compaction receives a conflict instead of launching another summary. New messages may be queued, but their model execution must not overlap session-owned summarization. Release reservations on success, failure and cancellation; preserve pending input order.

A successful durable canonical compaction/end is the authority for history replacement. Checkpoint JSON is derived cache: publish using a unique temporary file, sync and atomic rename with cleanup; rebuild from a valid canonical end when cache is missing/corrupt. Cache publication failure after canonical success is not a second failed semantic transaction. Do not promise stronger power-loss guarantees than the filesystem tests demonstrate.

Validate positive safe-integer coverage, matching filename, nonempty bounded summary and valid provenance against an actual completed session boundary and committed end. Reject future, active-turn or mismatched coverage. Legacy facts qualify only when their existing fields prove eligibility; otherwise retain canonical history. Builder consumers must not discard history based on unchecked coverage.

## 4. Tail and automatic trigger

Accept explicit zero for zero-capable limits. Retain the configured covered raw tail where useful, but ensure covered duplication cannot prevent compacted context from fitting; reduce duplication only by whole covered turns and record the omission. Never count uncovered turns against the covered-tail cap or drop an active task.

Enable automatic compaction in the standard web host at pressure 0.85 after the safety fixes, while preserving an explicit zero disable setting. Trigger only for compact-history sessions at an eligible completed boundary. Associate pressure with the settled turn; do not reuse another turn's cached manifest. Include pre-trim pressure/history omission evidence so microcompaction and whole-turn trimming cannot silently suppress the trigger. Deduplicate by covered completed boundary rather than lifecycle event sequence. A failed attempt is visible and bounded, not retried in a tight loop.

Keep last-request manifest semantics truthful: compaction does not pretend a request was reassembled. The next real request proves checkpoint consumption. Headless integration is deferred; document that limitation rather than claim host parity.

## Verification

Write failing regressions before product changes for:

- Invalid/missing completion, tool-call output, unbounded/hanging stream and cancellation.
- Empty/oversized custom summaries and later-chunk failure preserving prior eligibility.
- Rewritten effective tool identity, covered text attachment requirements and image references.
- Concurrent compact requests and queued messages, Stop/delete/shutdown during summary.
- Cache write/sync/rename failures, incomplete transaction recovery, invalid coverage and legacy fallback.
- Zero tail overrides, compacted request reduction with oversized covered turns, and unchanged uncovered/open task protection.
- Standard-host automatic enablement, explicit disable, fresh-turn pressure, pre-trim pressure and no repeated boundary attempt.

Run targeted context, storage, lifecycle and web compaction suites; typecheck; full tests; web build. Obtain independent whole-change review. Distinguish pre-existing failures from changes using non-destructive evidence. No live recovery is included in implementation verification.
