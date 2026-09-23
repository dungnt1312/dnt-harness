# Capabilities: the built-in tools

Capabilities are just tools registered into `ctx.tools`. This doc covers the
tool families a model can call: a granted-root filesystem toolset (canonical
names `Read`, `Write`, `Edit`, `Glob`, `Grep`) and a real-Bash shell tool in
`src/capabilities/`, plus the harness-registered `Skill`, `Agent`, five memory tools,
and the dynamically discovered `mcp__<server>__<tool>` family. The six
Claude-style built-ins are the canonical identity: legacy lowercase names
(`read`, `write`, ...) arriving from a model or an old permission map normalize
at the boundary — never as exposed duplicates.

```
src/capabilities/
├── fs/        Read/Write/Edit/Glob/Grep, granted-root containment
└── shell/     Bash: real bash, timeout, stop kill, process-tree cleanup
```

## Filesystem tools (`capabilities/fs/tools.ts`)

`fsTools()` returns the five tools. The workspace root is granted **per
execution** through `tools.setRootResolver(() => ({ root, deniedRoots }))` —
the web host resolves the calling session's own folder (falling back to the
server default) through the ambient agent scope, so a folder switch applies
without re-registering anything. Root-aware tools fail closed when no grant
exists; they never derive authority from a UI-global folder.

### Root containment

Every path resolves through `resolveGrantedPath(root, target, deniedRoots)`:

- lexical escapes of the root are rejected;
- the existing portion of the path (including the creation path — the parent
  a new file would land in) is realpath-checked, so symlinks and Windows
  junctions pointing outside the root are rejected;
- paths inside `deniedRoots` — application-internal storage such as the
  session data dir — are refused even when they sit under the workspace.

This is application-level containment, **not an OS sandbox** and not a
guarantee against hostile external filesystem races.

```ts
export function resolveWithin(root: string, target: string): string {
  const absRoot = path.resolve(root)
  const abs = path.resolve(absRoot, target)
  if (abs !== absRoot && !abs.startsWith(`${absRoot}${path.sep}`)) {
    throw new Error(`path '${target}' escapes the workspace root`)
  }
  return abs
}
```

Escaping is a **tool failure**, not a silent redirect.

### The five tools

| Tool | What it does | Constraints |
|---|---|---|
| `read` | read a text file, return its content | capped at 1 MB |
| `write` | create or overwrite a file, creating parent directories | — |
| `edit` | replace the **first** occurrence of `old` with `new` | fails if `old` not found |
| `glob` | list workspace files matching a `*` / `**` pattern | 100 matches max |
| `grep` | regex search across workspace files, `path:line: text` | 250 matches max |

Tool outputs are truncated to a 60 KB output cap with a `… [truncated N chars]`
marker. Argument errors throw inside `execute` and surface as failed
`ToolResult`s in the pipeline.

## Shell tool (`capabilities/shell/bash.ts`)

`bashTool(options?)` runs one command per call. **Bash means Bash**:

- **Executable**: resolved at registration by the shared
  `capabilities/shell/detect.ts` — an explicit `executable` option
  (authoritative: a missing one disables the tool), `MINI_DSH_BASH`, the
  standard Git install locations, or `where git` / `where bash` fallback
  (skipping the WSL launchers in System32 and WindowsApps). On POSIX,
  `/bin/bash` or `bash` on PATH. When nothing real is found, the tool
  registers but fails with an actionable error — it never silently
  substitutes another shell. The web host's Workbench terminals resolve
  through the same module, so "which shell is this" has one answer no matter
  who is asking.
- **Command**: `<bash> -lc <command>` (login shell, command string).
- **Output**: stdout and stderr captured together; capture stops shortly past
  the execution's output limit so a firehose command cannot exhaust memory,
  and the model-visible result is truncated with an explicit marker.
- **Exit code**: the resolved string ends with an `[exit code: N]` suffix, a
  `[terminated: timeout or stop]` marker, or `[terminated by stop]`.
- **Timeout & stop**: default 30 s (a per-call `timeoutMs` argument is
  clamped to the configured maximum). The run's abort signal also kills the
  command — stop reaches running tools.
- **Cleanup**: the child spawns detached into its own process group (POSIX:
  group SIGKILL; Windows: `taskkill /T /F` with a second pass for MSYS spawn
  races), and the call settles on the process `exit` event with a short
  grace, so a straggler grandchild holding the stdio pipes cannot stall the
  result.

A shell is never path-confined: Bash can reach anything the OS user can. Path
checks protect the file tools, not the shell. A `tools/rewrite` guard
(`src/harness/guard/`) can block or force-ask risky Bash commands by content
(preset groups + custom rules, workspace-scoped and Mode-independent — see
`docs/harness.md`); it does not sandbox the OS and does not resist obfuscation.

## The Skill tool (`src/web/server.ts`, service in `src/harness/skills/`)

`Skill` loads one workspace skill's instructions **on demand** — there is no
classifier and no auto-load:

- **Layered catalog**: names resolve workspace (`<data-dir>/workspaces/<id>/skills`)
  > user (`userSkillsDir`; the web bin passes `~/.claude/skills`) > bundled.
  Only workspace skills are writable; a workspace skill shadows a same-named
  user or bundled one.
- **Mode-gated**: the tool resolves the current mode through the ambient agent
  scope and refuses when the mode turns skills off; a live mode switch means
  the next call gates fresh.
- **Turn-local**: a loaded skill is pinned per session turn with a content
  hash; the context builder injects the pinned snapshot exactly once (no
  duplicate full-body injection), and the tool result is only a compact
  acknowledgement.
- **Content is data, never permissions**: skill text cannot grant capabilities
  or widen the permission policy — the mode's tool exposure stays the ceiling.

## The Agent tool (`src/web/agent-delegation.ts`)

`Agent` delegates a bounded task to a child agent and collects its result. One
tool, five actions — `spawn` (returns a handle at once), `wait` (blocks on
several children, capped at 120 s, honours Stop), `list`, `cancel`, `catalog`:

- **A prose brief**: `prompt` is the primary argument — written for a colleague
  who cannot see the conversation — plus `requiredResult`. The structured
  `objective`/`constraints`/`references` form stays accepted; with both, the
  prompt wins and the result says so. An empty brief is a typed `packet` error.
- **The child is its role**: the role's instructions are the child's *system*
  prompt (pinned at spawn), after a subagent preamble — its final message is the
  whole deliverable, nobody sees its intermediate work, it cannot delegate — and
  a capability line naming exactly the tools its request carries. The mode's
  role prose is not sent to a child. Prompt text grants nothing: the exposure
  gate, host policy and approval stay the enforcement.
- **The result is the child's answer**: a completed child returns its last
  assistant message that carried no tool calls as `result.report` (cut at
  16 000 chars with a `… [truncated N chars]` marker and `truncated: true`),
  plus `filesTouched` — the `Read`/`Write`/`Edit` paths, not Glob/Grep scopes.
  A cancelled, failed or interrupted child, or one that never wrote a final
  message, has no result and an `error` naming its session — the full log.
- **Inherited context is opt-in**: `inherit: "brief"` also hands the child up
  to 12 000 chars of this conversation's recent user/assistant *messages* —
  never tool calls, tool output or a compaction summary — captured at spawn,
  wrapped as lower-trust `parent-context` data, and dropped (with a manifest
  omission) under budget pressure before history is. Only its hash and size are
  stored; the spawn result reports the size. A role with `inheritable: false`
  refuses it. `references` are unaffected and still ride in the brief.
- **Asynchronous on purpose**: a step runs its tool calls in sequence, so
  `spawn` must return immediately for children to overlap. A conversation holds
  up to 3 active children (reported as `active: n/3`); the host caps all
  conversations at 12, and each root turn at 8 spawn attempts. A capacity
  refusal names which limit was hit.
- **Writers do not serialize**: a root turn holds the project lease from its
  first write until it settles. Spawning a write-capable child hands that lease
  off; the child then locks per call, nothing locks its whole run, and the
  root's next write can take the lease back. The tool therefore tells the model
  not to fan out writers or keep writing while one runs — parallel fan-out
  belongs to read-only roles.
- **One level**: a child is denied `Agent` before any ceiling or approval is
  consulted, whatever its definition lists.
- **Model per child**: the `model` argument (`provider:model`, or a bare name)
  overrides the role's own `model:`, which overrides the conversation's pair.
  The live catalog rides in the tool description and in `action: "catalog"`, so
  the model names an id the host can actually serve. See
  [the harness notes](harness.md#which-model-a-child-runs-on).
- **No authority gained**: a child's own calls re-enter the same mode exposure
  and approval policy, which is why `Agent` is `ask` only in *Ask before
  changes* and `allow` in Plan, *Edit automatically*, and *Full access*. Chat
  exposes it nowhere. In Plan a child is read-only by construction — it
  resolves the same mode.
- **Grants only narrow**: a `grantTools` entry the role lacks is reported back,
  never silently dropped.
- **Four bundled roles**, each described by when to pick it and each stating
  the shape of its final report: `explorer` (find and explain; read-only),
  `worker` (one decided edit; file tools, no shell), `reviewer` (find defects;
  read-only) and `verifier` (run tests/typecheck/build and judge; `Bash`, no
  file edits). `catalog` also lists the workspace's valid custom roles; copy a
  bundled role in Settings → Agents to customize it.

## Memory tools (`src/harness/memory/tools.ts`)

Five native tools over workspace/project-scoped Markdown files — writes are
always explicit, never auto-extracted from conversation:

| Tool | What it does |
|---|---|
| `MemorySearch` | keyword search across the workspace's memory entries |
| `MemoryRead` | read one entry by topic |
| `MemoryCreate` | create an entry (conflict-detected against existing files) |
| `MemoryUpdate` | update an entry (stale-state conflict detection) |
| `MemoryForget` | remove an entry |

Scope comes from the ambient agent scope (workspace, optional project); a
child agent sees only what its definition grants. Conflicting or invalid files
surface as tool failures — they are never silently merged.

## MCP tools (`src/harness/mcp/`)

Servers from a workspace's `mcp.json` register dynamically as
`mcp__<server>__<tool>`:

- **Naming**: the `mcp__<server>__<tool>` namespace is reserved-protected —
  no MCP tool can shadow a built-in identity (`Read`, `Skill`, `MemorySearch`,
  ...), and the built-ins cannot be re-registered by a server.
- **Workspace isolation**: one connection per (workspace, server); two
  workspaces pointing at the same server name get separate connections, and
  dynamic schemas are workspace-scoped.
- **Permissions**: the selected mode's `permissionDefaults` are the only
  permission map. Lookup is exact name, then `mcp__server__*`, then catch-all
  `*`, then `defaultMode`. `--yolo` maps asks to allows but preserves explicit
  denies. Host `blockedTools` can never be widened. A tool annotated
  `requiresUserInteraction` **always asks**, regardless of the selected mode.
- **`allowedTools` is exposure-only**: it filters which tools appear in
  request schemas — it is never a permission bypass, and every call still goes
  through the same pre-execute waterfall as built-ins.
- **Watchdogs**: stdio servers run one OS subprocess per (workspace, server)
  under CPU/memory/lifetime watchdogs with process-tree kill — application
  control, **not an OS sandbox**. The child environment is the platform
  baseline plus the server's own env. Hard resource limits are refused
  unless this host has a tested Windows Job Object or a delegated Linux
  cgroup v2; this build does not claim that primitive. Stripping unrelated
  environment variables is also not a sandbox, and it does not protect
  against code running as the same user.
- **One dispatch**: a `tools/call` is sent at most once. A lost response is
  `indeterminate` and is not replayed. The intent is appended to
  `workspaces/<id>/mcp/executions.jsonl` before the send. Saving a server
  does not start it; Enable does. PM2 must stay a single fork instance.
- **Outcomes**: an MCP result may be `success`, `error`, `indeterminate`, or
  `audit_fault`. `indeterminate` means the call may already have run remotely
  and is never retried automatically. `audit_fault` means the known outcome
  could not be durably recorded, so further MCP dispatch stays blocked.
  Server-supplied names, descriptions, schemas, and annotations are untrusted
  model context; an annotation never lowers an approval requirement.
- **Boundaries**: protocol pin, dispatch receipt, rollback floor, and the
  control-plane route inventory live in
  `docs/decisions/mcp-production-boundaries.md`. Filesystem encryption and
  local authentication do not protect against same-user malware or
  same-origin XSS.

## Mode permission defaults

A workspace mode's raw Markdown frontmatter owns its `toolExposure` ceiling and
`permissionDefaults` decisions; there is no workspace override layer or
`policy.json`. In **Settings → Modes**, the catalog displays
those entries literally — including the `*` fallback and `mcp__server__*`
patterns — rather than simulating gate resolution. Bundled modes are read-only
and must be duplicated into the workspace before editing; workspace mode files
use hash-checked writes. A saved change takes effect when the mode is next
selected because an active selection retains its cached snapshot.

## Where they are mounted

- **Headless CLI** (`src/bins/headless.ts`): `fsTools()` plus `bashTool()`,
  with the root resolver granting the session's project root and denying the
  app's own data directory.
- **Web host** (`src/web/server.ts`): the same pair, with the root resolver
  reading the ambient agent scope — a session bound to a project gets that
  project's folder; a workspace-mode session with no project has **no
  filesystem grant**; memory-mode sessions keep the legacy per-session/default
  folder grants. `Skill` and the memory tools register with the harness; MCP
  tools register per workspace as its servers connect.

## Reading further

- Filesystem tool tests: `tests/capabilities/fs-tools.spec.ts`.
- Bash tool tests: `tests/capabilities/bash.spec.ts`.
- Skill/memory/MCP tool behavior: `tests/harness/g3-context.spec.ts`,
  `tests/harness/g4-agents.spec.ts`, `tests/harness/g5-mcp.spec.ts`.
