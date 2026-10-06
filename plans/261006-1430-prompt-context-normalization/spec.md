# Prompt & Context Normalization — Spec

Date: 2026-10-06 · Branch: `feat/prompt-context-normalization`

## Problem

The system prompt / context injection pipeline has five gaps found in review:

1. **No environment context.** No request tells the model today's date, the
   OS/platform, or (for root sessions) the git branch of the project folder.
   Models answer time questions wrong and propose GNU-vs-BSD command variants
   blindly.
2. **Injection hardening gaps in `wrapUntrusted`.** Only the closing tag is
   neutralized; a forged *opening* `<untrusted` inside content can still
   fabricate envelope structure, and `meta` values are interpolated into
   double-quoted attributes without escaping.
3. **Inconsistent trust placement.** Workspace `INSTRUCTIONS.md` is wrapped
   lower-trust but rides *inside* the authoritative system message #1, while
   every other wrapped source gets its own message. The breakdown derives
   `metaContext` by subtraction instead of direct measurement.
4. **Mode/role provenance is invisible.** A workspace-authored mode's
   instructions are injected with the same authority as bundled ones; the
   manifest records `modeHash` but not *whether the mode is trusted*, and the
   same applies to the child's role definition.
5. **No contract doc / golden test.** The layout lives in comments and
   scattered tests; nothing locks the full shape root + child.

Non-goals (explicitly): append-mode system-prompt overrides (deferred — the
wholesale semantics are documented and tested), preamble deduplication across
wrapped messages (each message stays self-contained by design), retrieval
memory, tool-schema normalization.

## Target contract

### Message layout (root)

```
[0] system      — TRUSTED: base prompt | Mode — <name>: <instructions>
                  + <environment_context> (when supplied)
                  + file scope + compaction continuation note
[1] system      — wrapped lower-trust: workspace-instructions (own message)
[2] system      — wrapped lower-trust: compacted-history (fixed cost)
[3] system      — wrapped lower-trust: parent-context (droppable)
[4] system      — wrapped lower-trust: skill-catalog (droppable)
[5..] system    — wrapped lower-trust: each active skill (droppable as a group)
[..] system     — wrapped lower-trust: memory entries (guidance + indexes)
[..] user/assistant/tool — conversation history
```

Child: `[0]` carries the child preamble + capability line + role body instead
of base+mode, and still gains environment context + file scope. Parent-context
and everything after are identical to root.

### `<environment_context>` (P0-1)

Trusted block appended to the system parts, after the identity/mode text and
before file scope:

```
<environment_context>
Today: 2026-10-06 Monday · 14:30 +07:00
Platform: darwin arm64 · Node v22.9.0
Workspace: /abs/project (git branch: feat/x)   ← root only, when known
</environment_context>
```

- **Cache stability:** minute-level timestamp, rounded down (`HH:MM`), and the
  git branch cached per project root for the server's lifetime (refresh on
  each request is NOT acceptable; a stale branch is a documented trade-off —
  the git view remains the source of truth).
- Git integration reads the branch only, with the same `-c` hardening as
  `project-git.ts` (fsmonitor/hooks/pager off), 2s timeout, silent fallback
  (no block on failure — environment context never blocks a request).
- Supplied by the caller as an optional `environment?: string` on
  `BuildContextInput`; the builder never computes time/platform itself so
  tests stay deterministic. A dedicated module `src/harness/context/environment.ts`
  renders the block from injected facts (pure, testable), and the web server
  composes facts (date, platform, workspace path, git branch via cache).
- Not droppable; measured in `systemPrompt` breakdown; `sections` gains kind
  `'environment'`? — **Decision: NO.** The block rides inside the system
  message, and `sections[0]` already captures the whole system text including
  it. Adding a separate section would double-count. Manifest records it under
  `sources.environment = { date, platform, gitBranch? }` for observability.

### `wrapUntrusted` hardening (P0-2)

- Neutralize both delimiters: `</untrusted` (as today) **and** `<untrusted`
  (case-insensitive) → backslash-escaped.
- Escape `"` in `meta` attribute values → `&quot;` (kind stays
  host-controlled, meta interpolates skill names / memory ids / char counts /
  hashes).
- Existing forged-closer test keeps passing; add opening-tag + quote cases.

### Workspace-instructions placement (P1-1)

- Move from `systemParts` to a dedicated wrapped system message inserted
  immediately after `[0]` (before compacted-history). Not droppable (same
  fixed-cost semantics as compaction — mode enabled it, the user wrote it).
- `breakdown.metaContext` becomes direct measurement: workspace-instructions
  message + memory messages + inherited message. `systemPrompt` no longer
  subtracts.

### Mode/role provenance (P1-2)

- `manifest.sources.modeSource?: 'bundled' | 'workspace'` and
  `manifest.sources.child.source?: 'bundled' | 'workspace'`.
- No trust change yet (documented decision in prompt-contract.md): workspace
  modes/roles keep riding trusted; the exposure/permission gates are the
  enforcement boundary. This field makes drift auditable and unblocks a later
  wrap-if-untrusted change without touching the manifest again.

### Base prompt skeleton (P1-3, folded into P0 work)

`DEFAULT_BASE_SYSTEM` gains, in order: identity, environment awareness note,
tool-use discipline, honesty about uncertainty, language mirroring, TodoWrite
trigger. TodoWrite guidance is de-duplicated: the tool description keeps the
detailed rules; the base prompt keeps a single short trigger sentence.

`DEFAULT_CHILD_SYSTEM` unchanged (already tight and tested).

### Golden contract test (P1-4)

`tests/harness/g5-prompt-contract.spec.ts`: one root assembly with every
source enabled asserts, on `messages` + `sections` + `manifest`:
- exact role sequence and count of system messages;
- ordering of wrapped sources (workspace-instructions → compaction →
  parent → catalog → skills → memory → history);
- trust invariants: untrusted bodies never appear unwrapped outside their
  envelope; trusted text never appears inside an envelope;
- manifest sums (breakdown adds up to usedTokens);
- child variant: same invariants with preamble/capability/role body.
Golden lock: when this test changes intentionally, the diff IS the contract
change — reviewed as such.

### Docs (P1-5)

`docs/prompt-contract.md`: source-by-source table (kind, trust, placement,
droppable, hash semantics), the environment block format, override semantics,
child differences, trim order, and the deliberate non-goals. `docs/harness.md`
mode-driven-context section updated to match.

## Files

| File | Change |
|------|--------|
| `src/harness/context/environment.ts` | NEW — pure renderer + facts interface |
| `src/harness/context/builder.ts` | `environment` input, hardened `wrapUntrusted`, workspace-instructions message, `modeSource`/child.source, base prompt |
| `src/web/server.ts` | compose environment facts (date/platform/workspace/git cache) + pass `environment`; pass `mode.source`; pass child definition source |
| `src/web/agent-delegation.ts` | surface child definition source if not already on the resolved definition |
| `src/bins/headless.ts` | compose + pass environment (no git) |
| `web/lib/types.ts` | `ContextManifestView.sources.modeSource`, `child.source`, `environment` |
| `web/components/workbench/StepInspector.tsx` | SECTION_KIND unchanged (no new section kind) |
| `web/components/chat/context-marker*` | show env facts if trivially available (skip if invasive) |
| `tests/harness/g5-prompt-contract.spec.ts` | NEW golden test |
| `tests/harness/g3-context.spec.ts` | update placement assertions |
| `tests/web/server-system-prompts.spec.ts` | update if layout assertions shift |
| `docs/prompt-contract.md` | NEW |
| `docs/harness.md` | update section |

## Success criteria

1. A root request with all sources on carries the env block, and the model can
   answer "what OS / what date is it" from context alone.
2. Forged `<untrusted` openings and `"` in hostile meta cannot break envelope
   structure (unit-tested).
3. Workspace instructions ride their own message; breakdown parts still sum to
   `usedTokens` within ±2 tokens.
4. Manifest reports `modeSource` and child source; UI unaffected.
5. Golden contract test locks root + child layouts.
6. `npm run typecheck` and the full vitest suite pass; browser tests for
   context UI unchanged.
7. No request-latency regression: git branch read at most once per project
   root per server lifetime; date/platform computed synchronously.

## Risks

- **Prompt-cache churn from the timestamp.** Mitigated: minute granularity and
  fixed block position; sessions typically run within one hour anyway, and the
  block sits before stable history so prefix cache impact is bounded to the
  system message itself.
- **Moving workspace-instructions changes request shape.** Snapshot-style
   assertions in g3/g4 tests updated in the same commit; the message split is
   invisible to providers (same content, one extra system message).
- **Base prompt growth.** ~60 → ~140 estimated tokens. Measured by the budget
  as `systemPrompt`; the squeeze ladder already handles tight windows.
- **Git lookup stalls assembly.** Cached, timeout 2s, silent omit; worst case
  the block lacks the branch line.
