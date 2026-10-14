# Local Claude Code 2.1.293: compaction implementation inspection

Date: 2026-10-13, Asia/Saigon. Read-only inspection of installed program; no credential/config/session transcript reads, no model calls, no program patches or dependency installations.

## Binary identity and method

- Launcher: `/Users/dungnt/.local/bin/claude`, symlink to `/Users/dungnt/.local/share/claude/versions/2.1.293`.
- `claude --version`: `2.1.293 (Claude Code)`.
- Mach-O arm64 executable, 236,330,608 bytes.
- SHA256: `4e21122a227857da1178aca3299700c1fd7f2b77c93f12e73c2c76db796a105e`.
- Embedded build metadata: `BUILD_TIME: 2026-10-07T06:36:42Z`, `GIT_SHA: 3abc54a9d60b4d12c627afad22d6e5f58a6199d2`.
- `otool -l` identifies `__BUN/__bun` at file offset 68,206,592, section size `0x09fad346`. The payload contains bytecode/string tables and readable minified JavaScript modules. Examined bounded snippets directly with read-only mmap; did not write an extracted proprietary bundle into the repository.
- Offsets below are absolute byte offsets in this exact executable. Minified identifiers repeat across separate modules: identifier alone is not unique. No source map was found by the initial exact-string probe; this is not proof none exists elsewhere.

## Findings

### 1. Cache-sharing summary is real code

At offset 194,662,073, within the summarization helper `aZt`, the cache-sharing path calls `GC` with `promptMessages: [summaryRequest]`, inherited `cacheSafeParams`, `querySource: 'compact'`, `forkLabel: 'compact'`, `maxTurns: 1`, `skipCacheWrite: true`, `skipTranscript: true`, shared cancellation and attempt budget. It reports cache read/write tokens and cache hit rate via `tengu_compact_cache_sharing_success`.

The fork helper `GC` at 194,629,463 explicitly appends new prompt messages to `forkContextMessages`, keeps the parent system/user/system context and rejects changing parent tools without declaring a new prefix. This corroborates the official documentation about prefix-preserving summaries. `maxTurns: 1` is a logical model-turn limit, not proof of exactly one physical HTTP attempt.

This branch is gated by `!stripNonEssential && C('tengu_compact_cache_prefix', true)`. If no usable text or an error occurs, there is a separate fallback summarization path; inspected fallback uses a generic summary system prompt and `enablePromptCaching: false`. Do not describe every compact path as cached.

### 2. Precomputed/background compaction exists, including manual reuse

At 194,688,593, `WN()` enables this only if `im()`, `IV()`, feature flag `tengu_sepia_moth` (lookup default false), and preference `precomputeCompactionEnabled` (lookup default true) permit it. Flags were not resolved at runtime, so local installation alone does not establish enabled status.

At 194,693,925, `JKr/QKr` checks token-pressure eligibility and starts an async task with a separate AbortController and a history coverage snapshot. It sets a `pending` state without awaiting the entire summary at launch. The task invokes PreCompact hooks and the reactive summary routine with `allowFallback: false`, then transitions to `ready` or `failed`. There is a three-counted-failure rearm cap. Telemetry includes `started`, `ready`, `failed`, arm fraction, lead time and generation duration.

At 194,604,429, the consumer validates coverage, keeps newly appended tail messages, and finalizes a precomputed result. At 206,536,327, the manual command path also validates and reuses a ready precomputed result; it records `manualPrecomputeReuse: 'hit'` and `waitedMs`. Thus short visible compact latency can be a summary generated earlier, not faster generation at the instant the spinner appears. Whether this occurred in the user's sessions requires separate runtime evidence.

Optional sidecar persistence/re-hydration appears around 194,692,138–194,693,389, gated additionally by `tengu_amber_packet`. A ready summary can be persisted and validated on resume; presence does not prove active rollout.

Coverage validator `vvr` at 183,994,992 checks boundary UUID, covered/kept entries, unexpected assistant replies, hook rewrites and post-swap fit. It refuses stale results; it is not a blind replacement of the latest history.

### 3. Multiple summary prompts, not one fixed format

At 194,581,310, the lean prompt states that retrievable detail needs only a pointer: a path, command or name. It emphasizes user intent, decisions, approaches ruled out, current state, exact restrictions/permissions and next action. It explicitly says work pauses while writing this summary.

Nearby `Isr` maps four arms: `control`, `lean`, `short`, `capped`. `capped` asks for 2,000 words or fewer; `short` prioritizes six continuation categories without requiring nine headings. `Lge` at 194,592,811 chooses via environment/config flag with lookup fallback `control`. Therefore code does not establish that the user's session uses lean or capped. Existing verbose nine-section-style prompts also remain in the program.

The summary formatter can provide a full-transcript path for fetching exact details later, and can mark earliest context as not covered after last-resort truncation. This is explicit loss-awareness rather than pretending to summarize every original event.

### 4. Restore and measure full continuation context

At 194,643,420, restoration constants are five files, 5,000 tokens/file, 50,000 aggregate attachment token budget; skills are 5,000 tokens/skill and 25,000 total. `Vge/xir/Pir/Air` at 194,669,856 restore selected files, plan, skills and other reminder state; file read operations use `Promise.all`.

The full compact orchestration around 194,650,399 measures summary-only and true post-restore token counts, reports `willRetriggerNextTurn`, stores duration and uses compact hooks. It returns no raw kept messages for full compaction; reactive/precompute uses preservation separately.

### 5. Oversized input is bounded retry, not sequential transcript fold

At 194,646,419, prompt-too-long retry cap is three. `QJt/Hge` drops oldest grouped rounds using a token gap when available, otherwise approximately 20%, and inserts `[earlier conversation truncated for compaction retry]` when necessary. This sacrifices old source coverage. It must not be ported as an unannounced performance-only change.

### 6. Thinking inherits session policy

`Xze` at 187,937,848 resolves session thinking configuration and permission overrides. The fallback summary request explicitly passes `thinkingConfig: Xze(context)`; cache-sharing forks inherit context. No evidence supports a universal Haiku/thinking-off shortcut.

## Revised recommendation

The strongest portable foundation remains a structured effective-context summary using the existing prefix. However, this binary adds a second important performance layer beyond the docs-based review: guarded speculative/precomputed compaction, with append-tail preservation, coverage/fit validation and optional persistence. It can hide summary generation from the user's blocking path.

A useful local design separates (1) summary source/provenance and stable prefix, (2) continuation restoration, (3) speculative computation versus atomic adoption. Do not increase chunk size as the main solution, and do not implement background swap before defining correctness across concurrent new turns and hooks. Preserve dnt-harness's durable canonical checkpoint, but adapt its current no-new-turn-during-compaction invariant if precompute/adoption is introduced.

## Limitations and next evidence

This is static inspection of code contained in the installed version. Feature flags, selected prompt arm, actual cache hits and precompute reuse remain unknown. No latency benchmark was run and no license rights to redistribute implementation code were assessed; report records behavioral findings and offsets only. Further runtime verification should inspect only opt-in relevant diagnostic events/counters, not credentials or whole private chat histories.

The global pnpm-root lookup failed with `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`; this was a package-location diagnostic, not a skill-script failure. Native install discovery made that lookup unnecessary.
