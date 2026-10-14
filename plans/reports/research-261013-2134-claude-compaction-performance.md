# Claude Code compaction: performance and continuation quality

Research timestamp: 2026-10-13, approximately 21:42 Asia/Saigon. Scope: current public Anthropic documentation fetched successfully during this session; Claude Code behavior distinguished from optional Claude API capabilities. No Claude Code source reverse engineering, local user transcript inspection, credential access, benchmark or implementation changes.

## Outcome

Anthropic explicitly documents that Claude Code's summarization request uses the same system prompt, tools and history as the active conversation, with a final user summarization instruction appended. With a warm cache, it reads the prefix from cache and spends most time generating the summary. This directly supports an effective structured-context, cache-preserving normal compaction path rather than dnt-harness's raw transcript sequential fold.

Compaction quality is not summary alone: older tool outputs are cleared first, critical state is summarized, then files/instructions/plan/skills/runtime reminders are restored selectively. Public documentation does not establish that Claude Code's ordinary `/compact` uses the new signed server-side API compaction block, a pre-generated background summary, a fixed fast model or a fixed small output budget.

## Verified Claude Code mechanics

1. **Separate prefix-preserving summary request.** Same system, tools and history; appended final user instruction. A warm prefix is cache-read; a cold session must reprocess history. The next ordinary request rebuilds only the shorter conversation layer. System prompt reuse is conditional on resume prompt policy; disk-reloaded CLAUDE.md/memory only cache-hit if unchanged. [1]
2. **Clear before summarize.** Official architecture docs say older tool outputs are cleared first, conversation summarized if needed. User requests and key snippets survive, but early detailed instructions can be lost. Persistent rules belong in CLAUDE.md. [2]
3. **Explicit restoration after summary.** Root CLAUDE.md, unscoped rules, auto memory and the plan are re-injected from disk; git status is refreshed. Up to five read/edited files are re-read, most recently modified first; over-5k-token files return as references. Invoked skills are restored with 5k tokens/skill and 25k total, dropping oldest first. Background commands/agents continue and receive reminders to avoid duplicate work. SessionStart compact hooks run. Scoped rules and nested CLAUDE.md reload on demand. [3]
4. **Thinking is not secretly guaranteed off.** Since v2.1.198, the summary request inherits session extended-thinking configuration. Summary generation can therefore still reason; public docs do not justify a universal "Haiku with thinking off" claim. [3]
5. **No universal 200k assumption.** Current model docs describe native 1M models compacting around 967k by default, with exceptions for cloud, configuration, legacy models and gateways. The actual user's client version and gateway limits need verification before comparing latency. [4]
6. **Critical state over archival completeness.** Anthropic's engineering article describes preserving architecture decisions, unresolved bugs and implementation details while discarding redundant outputs/messages, and continuing with compressed context plus recent files. It recommends maximizing recall before optimizing precision. The article says most recently accessed files; current detailed docs specify most recently modified first, so use the latter for current restoration ordering. [5]

## Why this explains faster compaction

The documented normal path avoids the local fallback's 7–9 sequential merged summaries and repeated intermediate output generation. Keeping the effective request shape enables cache reads instead of re-prefilling a newly flattened transcript. Clearing old tool outputs reduces active context without reviving them from the audit log. Selective restoration reduces how much file content and durable rules the summary must carry itself.

These are architectural explanations, not a benchmark. A warm cache accelerates input processing, not output generation. Cold cache, large summaries, thinking, provider queuing and gateways can still make a one-request compaction slow. Earlier dnt-harness usage records reported zero cached tokens, but that does not prove a gateway cannot support caching or that an exact prefix would hit.

## Claude API: separate capabilities, not proof of Claude Code internals

Current on-demand compaction uses beta `compact-2026-09-04`, top-level `compaction: { type: 'summarize' }`, and returns one signed compaction block with stop reason `compaction`. The same model, system, tools, thinking settings and max_tokens apply. Never execute a tool during that summary. Keep the block unchanged, remove covered messages and send it first thereafter. The conversation must fit before compaction. Usage is reported in compaction iterations. [6]

Background compaction is explicitly supported as an application pattern: snapshot N messages, launch one compaction request while new turns append, replace exactly those N when the block arrives, retain later turns, and use the swapped history on the first next request. One pending compact at a time; leave headroom and account for two concurrent requests. Failure keeps full history. [7]

On-demand compaction is distinct from threshold compaction and client-written summaries. Anthropic's overview distinguishes them explicitly. [8] Do not assume cliproxy's OpenAI-compatible surface or other providers implement the beta, signed blocks, preserved-thinking semantics or usage schema without a capability probe.

## Implication for dnt-harness

Primary portable change: use a committed effective structured conversation as the normal summary input; preserve system/tools/history prefix and append only the summary instruction. Share intentional tool-result clearing between ordinary request context and compaction, rather than rebuilding cleared raw outputs from events. Keep original events as the audit record.

The current cache-aware path already sketches the request shape but its `omissions.length === 0` gate and 200k-character gate exclude many long sessions. Replace these only with explicit provenance/coverage and eligible-omission policies, not by blindly deleting checks. Persist/recover an effective-context snapshot for resume; a memory-only last-request map is insufficient.

Keep canonical checkpoint durability, cancellation, boundary ownership, incremental recovery and bounded user-message retention. Add targeted restoration of continuation state as a separate measured contract, especially files, accepted plan, skills and active background work. Do not restore unbounded raw turns.

A provider-native compaction capability can be optional after verifying actual gateway support. The portable path must remain available. Background compaction is a subsequent latency-hiding option, not proof of why the user's Claude Code run was fast, and requires changing today's no-new-turn-during-compaction transaction invariant.

Verify effectiveness with current task/constraints/pending work/verified outcomes retained, no duplicated running work, summary size and true post-restore context size. Verify speed using path, input/cache/output tokens, queue/first-token/generation time, retries and total wall-clock on warm, cold and resumed sessions.

## Sources

[1] https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation

[2] https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up

[3] https://code.claude.com/docs/en/context-window#what-survives-compaction

[4] https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds

[5] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

[6] https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand

[7] https://platform.claude.com/docs/en/build-with-claude/compaction-background

[8] https://platform.claude.com/docs/en/build-with-claude/compaction

## Open questions

- Which Claude Code version, model, provider and warm/cold cache conditions underpin the user's comparison?
- Does the configured cliproxy gateway preserve cache behavior and support native compaction blocks? This research did not issue billable model probes.
- Which omitted facts can the local coverage contract accept, and what committed effective projection should be restored after restart?
