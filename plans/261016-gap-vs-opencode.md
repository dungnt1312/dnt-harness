# Gap analysis — dnt-harness vs opencode (v2 source)

Date: 2026-10-16
- Left: **dnt-harness** `C:\laragon\www\dnt-harness` (branch `fix/effort-vocabulary-and-prompt-discipline`, v0.2.0)
- Right: **opencode** `C:\laragon\www\opencode` (monorepo v2.0.31, 35 packages; installed CLI on this box is v1.2.24)
- Method: read both trees + opencode `specs/v2/*`, package.json manifests and specs/ inventories. Nothing modified in either tree.

Legend: ✅ present · 🟡 partial/planned · ❌ absent

## 1. Executive summary

dnt-harness is a **single-package, from-scratch harness** whose distinguishing asset is its
small, readable, Cordis-inspired plugin kernel and a very explicit *prompt/context contract*
(per-request manifest, budget, calibration, tiered trim, compaction checkpoints). It is
strong where opencode is architecture-heavy: memory, modes, media tools, and a documented
G1–G5 reliability ladder.

opencode is a **product platform**: a typed HTTP protocol + SDK, an Effect-based core with
crash-recovery semantics (write-ahead execution claims, affinity, retry, max-steps), ~36
provider plugins with OAuth, a TUI/desktop/app trio, a runtime plugin API, snapshots/undo,
worktrees and stats. dnt-harness reaches roughly the *same agent capability surface* as
opencode's agent (tools, sessions, MCP, skills, subagents, permissions) but not the
*platform surface* (protocol/SDK/UI clients/providers/plugin runtime).

The single most important measured gap is **per-request context overhead**: opencode's
baseline request is ~22k input tokens for a trivial prompt vs ~4.4k for dnt-harness (see
`plans/261016-bench-*.md`).

## 2. Architecture

| Area | dnt-harness | opencode v2 | Gap |
|---|---|---|---|
| Runtime model | Mini-Cordis kernel: EventBus with 5 dispatch modes (`emit/parallel/serial/bail/waterfall`), fibers with reverse-order effect disposal, flat service store, `inject` dependency boot, YAML loader (`src/kernel/*`) | Effect layers + `Location`-scoped services + `Scope`; plugin runtime with hooks (`packages/core/src/plugin/*`, `packages/plugin/src`) | 🟡 Different, both valid. opencode has Effect's interruption/retry semantics; dnt has reversible effects + typed declaration merging |
| Layering | strict lower-only layers (kernel → harness → capabilities → web) | package-enforced (protocol/schema/core/server/sdk/clients) | ✅ comparable |
| Distribution | 1 npm package, runs TS via `tsx`, prebuilt web client | 35-package workspace, Bun, native binaries | ❌ dnt has no multi-client distribution |

## 3. Agent loop & sessions

| Capability | dnt-harness | opencode v2 | Gap |
|---|---|---|---|
| Durable event-sourced session log | ✅ `events.jsonl` canonical + rebuildable `summary.json`, torn-tail quarantine, fsync barriers | ✅ SQLite + projector (`session/store.ts`, `session/projector.ts`) | ✅ comparable (dnt = file-first, opencode = DB) |
| Turn/step driver | ✅ `agent/pre-step`, `agent/request`, `turn-stopping`, inbox send/inject | ✅ `session/runner/*` (step, retry, model, max-steps) | ✅ comparable |
| **Step budget / deadline** | ❌ by design ("the model decides when the turn ends"); only user Stop and watchdogs | ✅ `session/runner/max-steps.ts` + retry + output-token fallbacks | 🔴 gap — a runaway loop has no harness-level ceiling (mitigated on this branch only by prompt discipline) |
| Crash recovery | ✅ interrupted turns, unknown-outcome records, invalidated approvals | ✅ write-ahead execution claim, `execution/restart.ts`, affinity | 🟡 opencode's execution ownership model is more complete |
| Fork | ✅ session log fork | ✅ fork (`before`), revert, move, transfer | 🟡 opencode adds revert/undo + move/transfer |
| Undo / revert / snapshots | ❌ | ✅ `snapshot.ts` (content-addressed git trees), `revert.ts`, `diff.ts`, `vcs.ts` | 🔴 gap |
| Compaction | ✅ manual + auto, immutable checkpoints, headless/precompute, calibration | ✅ auto/overflow/manual + **native provider compaction** + shrink steps + keep/buffer | 🟡 opencode has native provider compaction |
| Context manifest / budget | ✅ truthful per-request manifest, tiered trim (skills→memory→oldest turns), char/ratio estimator | 🟡 model-request output limits + compaction window logic | ✅ dnt advantage: explicit, auditable |
| Session sharing / export-import | ❌ (export?) | 🟡 share flag only (no v2 endpoints), session export/import via CLI | 🔴 gap |
| Stats | 🟡 `usage.jsonl` | ✅ `session/stats.ts` + `stats` package + CLI `stats` | 🔴 gap |

## 4. Tools

| Tool | dnt-harness | opencode v2 |
|---|---|---|
| Read / Write / Edit | ✅ (canonical; `ApplyPatch` too) | ✅ (edit/write/patch/file-diff) |
| Glob / Grep | ✅ | ✅ |
| Bash | ✅ (Git Bash, process-tree kill, background via BashOutput/KillShell) | ✅ (shell + PTY groups) |
| TodoWrite | ✅ | ✅ (todo tool) |
| Skill | ✅ on-demand, hash-pinned | ✅ |
| Subagent / Task | ✅ one-level delegation, wait/cancel | ✅ subagent tool |
| AskUserQuestion | ✅ | ✅ (`question.ts`) |
| **WebFetch / WebSearch** | ❌ | ✅ both |
| MCP resource | ✅ (MCP client) | ✅ (`mcp-resource.ts`) |
| Media: Generate/Edit image, video, DescribeImage | ✅ | 🟡 image pipeline exists; not exposed as the same tool set |
| `opencode` self-tool | ❌ | ✅ |

Tool pipeline: dnt has a guarded `tools/pre-execute → execute → tools/post-execute`
waterfall with approval riding pre-execute; opencode has registry + permission assert +
`execute.after` hooks + output bounding/retention. ✅ Comparable; opencode adds managed
output storage and metadata channels.

## 5. Providers & models

| Capability | dnt-harness | opencode v2 | Gap |
|---|---|---|---|
| Provider implementations | 2: `OpenAiCompletionsProvider` + `DeepSeekProvider` (any OpenAI-compatible `/chat/completions`) | ~36 provider plugins + ~90 AI-SDK provider adapters (Anthropic, Google, Bedrock, Azure, xAI, Groq, Mistral, OpenRouter, Ollama/LM Studio/vLLM, …) | 🔴 large gap |
| Auth | API key in `providers.json` | API key **and OAuth** (GitHub Copilot, OpenAI, Anthropic), `auth.json`, credential store, integrations | 🔴 large gap |
| Model catalog | ✅ `model-catalog.ts`: context limits, reasoning levels, thinking-effort mapping, model aliases | ✅ models.dev snapshot + variants + model resolver | 🟡 dnt smaller but precise |
| Reasoning/effort control | ✅ (`minimal…max`; this branch fixes DeepSeek to declare the full range) | ✅ variants (`--variant minimal|high|max`) | ✅ comparable |
| Local model discovery | ❌ (manual baseURL) | ✅ ollama/lmstudio/vllm discovery every 30s | 🔴 gap |
| Org-managed provider policy | ❌ | ✅ `ManagedPolicy` final authority (`specs/v2/provider-policy.md`) | 🔴 gap |

## 6. Server, protocol & SDK

| Capability | dnt-harness | opencode v2 | Gap |
|---|---|---|---|
| HTTP API | ✅ REST + SSE (`createWebServer`) | ✅ typed `HttpApi` (~34 groups, ~143 endpoints) | 🟡 dnt untyped/ad-hoc |
| Event stream | ✅ SSE snapshot + `session/event` | ✅ `EventFeed` (4096/conn encoded queues), `event.subscribe` | ✅ comparable |
| SDK | ❌ | ✅ `packages/sdk` (Promise + Effect + workerd), `packages/client`, VS Code SDK | 🔴 gap |
| Codegen from contract | ❌ | ✅ `httpapi-codegen` | 🔴 gap |
| Server auth / pairing | ✅ `pair`, `--auth`, `--oauth-origin` | ✅ password session tokens + pairing | ✅ comparable |

## 7. Clients

| Client | dnt-harness | opencode v2 | Gap |
|---|---|---|---|
| Web UI | ✅ React (`web/`, prebuilt `web-dist`) | ✅ `packages/app` | ✅ comparable |
| TUI | ❌ | ✅ OpenTUI + Solid (`packages/tui`) | 🔴 gap |
| Desktop | ❌ | ✅ Electron (`packages/desktop`) | 🔴 gap |
| Shared UI / themes | 🟡 single client | ✅ `session-ui`, `ui`, `theme`, `storybook` packages | 🔴 gap |
| IDE integration | ❌ | ✅ `sdks/vscode`, `gui-extensions` | 🔴 gap |
| Terminal (PTY) | ✅ Workbench terminal (node-pty) | ✅ PTY + persistent PTY | ✅ comparable |

## 8. Plugins, MCP, hooks

| Capability | dnt-harness | opencode v2 | Gap |
|---|---|---|---|
| MCP client | ✅ stdio + Streamable HTTP, secrets, health/breaker, watchdogs | ✅ full client + resource tool | ✅ comparable |
| Command hooks | ✅ Claude `settings.json` hooks (PreToolUse block/rewrite, PostToolUse, UserPromptSubmit, SessionStart/End, PreCompact) | ✅ hook domains (aisdk/session/permission/shell/tool) | ✅ comparable |
| Plugin **management** (install/marketplace) | ✅ manifest/store/marketplace/service, MCP bridging, secrets | ✅ config plugin + `plugin` CLI (list/add/check/update/remove) | ✅ comparable |
| Plugin **runtime API** (author JS plugins, register tools/commands/providers) | 🟡 install/manage + MCP bridge; hot (un)load is **Phase 10 (planned)** | ✅ JS plugin SDK with effect API (tools, commands, providers, sessions, permissions) | 🔴 gap |
| Skills / agents / commands layering | ✅ project/workspace/user/bundled skills, 1-level agents, modes, memory | ✅ skills, agents (hidden subagents), commands, instruction discovery | ✅ comparable |
| **Modes ladder** (Chat/Ask/Edit/Plan/Full + custom) | ✅ first-class, gates tool exposure | 🟡 via agents + permission | ✅ dnt advantage |
| **Memory** (Markdown, 5 tools, keyword search, conflict detection) | ✅ first-class | ❌ (AGENTS.md/instructions only) | ✅ dnt advantage |

## 9. Security, permissions, isolation

| Capability | dnt-harness | opencode v2 | Gap |
|---|---|---|---|
| Permission model | ✅ mode `permissionDefaults` + approval policy + dangerous-command guard; app-level only, stated honestly | ✅ `Permission.evaluate` last-match-wins + saved approvals + plugin hook | ✅ comparable |
| Workspace isolation | ✅ ownership at service boundary, project binding, writer leases | 🟡 Location-scoped services | ✅ comparable |
| Secret storage | ✅ AES-256-GCM `secrets.json` | ✅ credential store | ✅ comparable |
| OS sandbox | ❌ (explicitly app-level; documented) | ❌ | 🟡 same posture |
| Secret scanning | 🟡 | ✅ gitleaks, `SECURITY.md` | 🔴 minor |
| Managed org policy | ❌ | ✅ | 🔴 gap |

## 10. Notable extras

| Area | dnt-harness | opencode v2 |
|---|---|---|
| Worktrees | 🟡 worktree-*aware* (index↔worktree diffs, `git worktree` guard rules, `.worktrees` path preset) but no first-class lifecycle | ✅ core `worktree.ts` + strategies | 🟡 opencode can create/manage worktrees in-core |
| Git integration | ✅ project git (branches/diff/hunks/conflicts/commit-message) | ✅ git/vcs/snapshot |
| Formatter | ❌ | ✅ `formatter.ts` + builtins |
| LSP | ❌ | ❌ (schema only, TODOs) — **neither has a runtime** |
| Observability | 🟡 audit events, usage log | ✅ Sentry + OTLP + request tracing |
| Media pipeline | ✅ image/video gen + describe | ✅ image + media providers |

## 11. Ranked gap list (dnt-harness → opencode)

1. **Provider breadth + OAuth + local discovery + models.dev catalog** (biggest functional gap).
2. **SDK + typed protocol + codegen + VS Code/IDE + TUI/desktop clients.**
3. **Runtime plugin API** (dnt is Phase 10 planned; opencode ships it).
4. **Loop robustness: max-steps budget, retry policy, execution affinity/restart, native compaction.**
5. **Undo/snapshots/revert + worktrees + session move/transfer/export/share.**
6. **Built-in WebFetch/WebSearch tools.**
7. **Stats dashboard + observability/telemetry.**
8. Formatter; managed org policy; secret scanning.

## 12. Where dnt-harness leads

- Readable mini-Cordis kernel with reversible effects and 5 dispatch modes.
- Explicit **prompt/context contract**: per-request manifest, budget, calibration, tiered trim.
- **First-class memory** and a **modes ladder** that gates tool exposure.
- **Media generation tools** (image/video/describe) as first-class tools.
- Lower baseline request overhead (measured; see benchmark report).
- Honest, documented application-level isolation boundaries.

## 13. Recommended next moves (prioritised)

1. Lower-risk parity wins: **WebFetch/WebSearch tools**, **max-steps ceiling** (bounded loop), **session export/import**.
2. Platform lever: extract a **typed protocol + SDK** from the existing REST/SSE so external clients and a future TUI are cheap.
3. Provider lever: an **OAuth + models.dev catalog + local discovery** adapter layer behind the existing `LlmProvider` seam.
4. Then Phase 10 runtime plugin API, then snapshots/revert.
