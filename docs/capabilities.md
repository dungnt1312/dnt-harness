# Capabilities: the built-in tools

Capabilities are just tools registered into `ctx.tools`. This doc covers the
tool families a model can call: a granted-root filesystem toolset (canonical
names `Read`, `Write`, `Edit`, `Glob`, `Grep`) and a real-Bash shell tool in
`src/capabilities/`, plus the harness-registered `Skill`, five memory tools,
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
checks protect the file tools, not the shell.

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
- **Permissions**: default **ask** for every MCP tool; per-tool and wildcard
  (`mcp__server__*`) policies overlay; host `blockedTools` can never be
  widened. A tool annotated `requiresUserInteraction` **always asks**,
  regardless of policy.
- **`allowedTools` is exposure-only**: it filters which tools appear in
  request schemas — it is never a permission bypass, and every call still goes
  through the same pre-execute waterfall as built-ins.
- **Watchdogs**: stdio servers run one OS subprocess per (workspace, server)
  under CPU/memory/lifetime watchdogs with process-tree kill — application
  control, **not an OS sandbox**.

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
