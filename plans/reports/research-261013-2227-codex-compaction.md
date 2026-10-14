# Codex compaction: source research and Claude comparison

Research: 2026-10-13, approximately 22:27–22:35 Asia/Saigon. No implementation edits, model calls or credential/session-log reads. `codex` was not found on PATH; this does not prove no app installation exists.

## Source identity and freshness

Local clone `/private/tmp/codex-research` is OpenAI's public repository at `a9b0815167c27ab13719dd12d13b63e02b70d221`, dated 2026-10-11. Its normal compaction path was inspected directly. A freshness check found GitHub main at `f6aca7dc461d6a9e0ae12828cd04845c31dd504e`, committed 2026-10-13T15:25:12Z. Relevant newer files were fetched read-only at that immutable SHA, not merged into the clone.

Critical delta: the October 11 clone had no inspected speculative/background compaction mechanism. The October 13 source has `session/async_compaction.rs`, background remote attempts and guarded prefix installation. Conclusions below explicitly distinguish the two; current main is not assumed to be the user's released client.

## Outcome

Codex uses structured active history, not an archival raw-event transcript folded chunk by chunk. It supports local text-summary compaction and provider-native remote V2 compaction. Current main also has optional speculative async compaction, under development and disabled by default, which starts at a configurable 65% of the full model context window when enabled.

## Local compaction

`core/src/compact.rs` clones session history, appends a synthesized summary prompt, renders `for_prompt` and uses a normal model stream with completion validation. It reuses one client session across retries. The stock compact prompt is a concise handoff: progress/decisions, constraints/preferences, next steps and critical references (`prompts/templates/compact/prompt.md`). It does not request nine exhaustive headings or full code listings.

After summary, newest user messages are retained under an approximate 20,000-token cap, with the boundary message truncated and metadata marked incomplete when necessary. Raw old assistant/tool history is not retained through this local construction. Initial world-state/context is rebuilt, then history is replaced and persisted. Existing summary is replaced by a new summary of current history; it does not reconstruct prior original covered events.

Context overflow removes the oldest history item and retries; ordinary transport retries use provider policy/backoff. This is a lossy recovery, not all-source chunking. A source comment claims oldest-item removal preserves cache; removing prefix content does not itself establish an exact-prefix cache hit, so do not adopt that comment as measured cache behavior.

## Remote V2 compaction

The inspected remote attempt clones active history, projects input items and tool specs, and appends `ResponseItem::CompactionTrigger {}`. It sends through the normal Responses stream/client session. The collector requires `response.completed` and exactly one `ResponseItem::Compaction`; missing completion or wrong count fails.

This is distinct from simply calling the public standalone `/responses/compact` endpoint. The provider-native item is opaque/encrypted; client source cannot reveal the backend summarization algorithm or establish a latency improvement from encryption itself.

Replacement retains eligible user/hook messages and selected small agent messages, under a 64,000-token retention budget. Agent messages over 10,000 estimated tokens and descendant progress/final-report classes are excluded. Optional features allow specific client-authored developer messages and explicitly marked named client tool outputs; this is not retention of every ordinary tool output. Rebuild world-state/context and install the compact item after retention.

Before remote input, the overflow helper can replace contiguous trailing eligible function/custom tool outputs until within estimated context, stopping at protected/non-rewritable boundaries. This is not the same policy as Claude clearing old tool outputs.

Remote stream retries are capped at two by the client source. Model fallback is capability/state-aware. Provider capabilities route OpenAI/Azure defaults to V2, unsupported providers to local, with overrides. No claim is made that every OpenAI-compatible gateway implements V2.

## Async compaction on current main

Read exact SHA `f6aca7d`:

- `features/src/lib.rs`: `AsyncCompaction` / `async_compaction`, `UnderDevelopment`, `default_enabled: false`.
- `core/src/config/mod.rs`: default start threshold 65% of full context, configurable 1–100 through feature config.
- `core/src/session/async_compaction.rs`: requires AsyncCompaction, remote V2 and no TokenBudget mode. Skips when already at blocking/post-turn threshold or before backend model pin is established. Captures history version, length, model slug/hash, auth-owner generation, backend turn state and window. Starts a tracked task and stores a result receiver; repeated equivalent attempts are suppressed.
- `take_ready` polls a candidate; `wait_for_pending` releases state lock while awaiting and checks generation/model/hash/auth identity. Failed jobs are discarded, completed usage still charged, shutdown cancels/drains tracked tasks.
- `compact_remote_v2_attempt.rs`: prepares a cutoff snapshot and returns `BackgroundCompactionCandidate` without installing it.
- `compact_remote_v2_installation.rs`: checks model slug/compaction hash, builds candidate replacement and uses the shared install primitive; rejected candidate can fall back once or skip based on policy.
- `session/mod.rs:4216+`: immediately under state lock, validates history generation, prefix length and auth owner; replaces only captured prefix and appends `current[prefix.len..]` unchanged. Normal append keeps generation; rollback/compaction changes it.

This is the same general split observed in local Claude Code: speculative computation is separate from atomic adoption, with tail preservation. Claude additionally has UUID/hook/fit validation and optional sidecar persistence in the inspected binary. Do not transplant Codex's length/generation checks unless local mutations reliably bump generation.

Manual compact source was fetched on main and did not show explicit async candidate consumption in that task. Unlike Claude manual reuse, this research establishes async reuse in automatic compaction interfaces, not universal manual reuse. No sidecar persistence for async candidates was established.

## Timing and alternate modes

Normal source supports pre-turn, mid-turn (including context-overflow recovery) and optional post-turn compaction. In the older inspected turn loop, post-turn compaction is awaited to serialize updates, not a concurrent summary. Async behavior on newer main must be distinguished from this post-turn pass.

`TokenBudget` is another gated mode: compaction resets a context window without model/server summarization. It has different retention semantics and must not be presented as a drop-in fast high-fidelity summary.

## Public API cross-check

OpenAI's current compaction guide documents server-side threshold compaction inside `/responses` using `context_management`, and a separate stateless `/responses/compact` endpoint. Both produce an opaque encrypted compaction item. The standalone endpoint returns a canonical window that can include retained items: pass its entire output as-is, do not prune it. For inline compaction with stateless chaining, pruning items before the newest compaction item is permitted; `previous_response_id` chaining has different handling.

This public API behavior is compatible with native compaction conceptually, but is not evidence that all Codex client paths use the standalone endpoint or the same backend implementation.

## Recommendation for dnt-harness

1. Portable baseline: compact structured effective history once, with stable prefix where possible, preserve a bounded set of original user messages, and rebuild current continuation context. Avoid mandatory raw-transcript fold.
2. Treat provider-native compaction as an optional capability. Persist/replay opaque items correctly if supported; cannot substitute encrypted OpenAI state for other providers or assume chat-completions gateways support it.
3. Add speculative generation only with an explicit cutoff/projection identity, mutation generation, atomic prefix adoption and tail preservation. Keep durability, cancellation and completed-attempt evidence. Account for rejected candidates' cost.
4. Measure blocking wait separately from full summary generation, input/cache/output tokens, retry count and true post-restore context. Short spinner time can mean earlier work, not lower token cost.

No latency guarantee or benchmark was established. Claude's cache-preserving fork, Codex's concise handoff/native item, bounded raw retention and both systems' guarded speculative paths are stronger ideas than larger sequential chunks.

## Sources

- https://github.com/openai/codex/tree/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src
- https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/core/src/session/async_compaction.rs
- https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/core/src/compact_remote_v2_attempt.rs
- https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/core/src/compact_remote_v2_installation.rs
- https://github.com/openai/codex/blob/f6aca7dc461d6a9e0ae12828cd04845c31dd504e/codex-rs/features/src/lib.rs
- https://developers.openai.com/api/docs/guides/compaction

## Open questions

- Which Codex released build/provider should the user compare against? No CLI on PATH was available.
- Does cliproxy support the exact Responses V2 trigger/output protocol, standalone compact or only ordinary chat summaries?
- What local mutation/coverage contract will make effective-history and speculative-prefix adoption safe?
