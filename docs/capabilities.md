# Capabilities: the built-in tools

Capabilities are just tools registered into `ctx.tools`. This doc covers the
tool families a model can call: a granted-root filesystem toolset (canonical
names `Read`, `Write`, `Edit`, `Glob`, `Grep`) and a real-Bash shell tool in
`src/capabilities/`, plus the harness-registered `Skill`, `Agent`,
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

`fsTools()` returns the five tools. The grant is resolved **per execution**
through `tools.setRootResolver(() => ({ root, additionalRoots, deniedRoots }))`
— the web host resolves the calling session's bound project folder (the
primary root) plus its extra granted folders through the ambient agent scope,
so grant changes apply without re-registering anything. Root-aware tools fail
closed when no grant exists; they never derive authority from a UI-global
folder.

### Granted folders

A run may use the **primary root** (the project folder, read-write) and any
**additional roots**, each `read` or `write` (`src/capabilities/fs/grants.ts`):

- **Project grants** — `additionalDirectories` in `project.json`: another
  project of the same workspace (followed by id, so retargeting it moves the
  grant) or any absolute folder. Every session of the project gets them.
- **Session grants** — the durable `session/grants` event (full list, last
  wins, with a `revision`). Added from the composer or by answering an
  out-of-grant approval "for this session".
- **Child agents** receive a snapshot of the parent's effective grant at
  spawn and never gain more. Their usable folders are that immutable maximum
  intersected with the owning parent's current effective grants, so parent
  removals and write-to-read downgrades narrow unstarted child file calls.

Every grant source goes through one validator (`src/web/folder-grants.ts`):
absolute existing directories only; never a drive root, the home folder
itself, a network/device path, anything overlapping app storage, the user or
bundled skills folder, or any enabled absolute skill-rule folder of ANY
workspace (recomputed from every workspace's rules at startup and after each
rules save), or anything overlapping the project's own folder (so a
relative path can never bypass a read-only grant).

The model is told the granted folders in its system block; Glob/Grep print
paths relative to the project folder inside it and absolute paths elsewhere,
so their output feeds straight back into Read.

### Containment

Every target resolves against the primary first, then matches the **longest**
granted root that lexically contains it (`classifyTarget` — purely lexical,
no filesystem access):

- network (UNC) and device paths (`\\host\share`, `\\?\`, `\\.\pipe\…`) and
  Windows reserved names (`NUL`, `CON`, …) are refused before any syscall —
  even a `stat` on a UNC path authenticates to the remote host;
- paths inside `deniedRoots` (application-internal storage) are refused;
- a write into a read-only granted folder is refused;
- inside a granted folder, the existing portion of the path (including the
  creation path) is realpath-checked against **that** folder, so symlinks and
  junctions pointing outside it are refused — never turned into a question;
- a path **outside every granted folder** throws `OutOfGrantError`. In the web
  host this becomes an approval (see `docs/harness.md`); only an allowed
  answer authorizes exactly that path for that one call, and a link along an
  approved path is refused rather than followed.

This is application-level containment, **not an OS sandbox** and not a
guarantee against hostile external filesystem races. Headless runs have a
single root: out-of-grant paths fail there.

Escaping is a **tool failure**, not a silent redirect.

### The five tools

| Tool | What it does | Constraints |
|---|---|---|
| `read` | read a text file, return its content | capped at 1 MB |
| `write` | create or overwrite a file, creating parent directories | — |
| `edit` | replace the **first** occurrence of `old` with `new` | fails if `old` not found |
| `glob` | list files matching a `*` / `**` pattern, optionally under `path` | 100 matches max |
| `grep` | regex search, optionally under `path`, `path:line: text` | 250 matches max |

Tool outputs are truncated to a 60 KB output cap with a `… [truncated N chars]`
marker. Argument errors throw inside `execute` and surface as failed
`ToolResult`s in the pipeline.

## Shell tool (`capabilities/shell/bash.ts`)

`bashTool(options?)` runs one command per call. **Bash means Bash**:

- **Executable**: resolved at registration by the shared
  `capabilities/shell/detect.ts` — an explicit `executable` option
  (authoritative: a missing one disables the tool), `DNT_HARNESS_BASH`, the
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
- **Foreground wait & stop**: managed commands wait 120 s by default, up to
  600 s via `timeoutMs`. Eligible commands still running return a process ID
  without killing or respawning; use `BashOutput` to watch. A bare `sleep`
  (including leading `VAR=value` assignments) and session-less calls retain
  foreground deadline termination. Foreground Stop
  kills the tree; committed background commands survive root turn Stop.
- **Child lifecycle**: explicit child cancellation stops owned processes; normal
  completion retains ownership and execution. Child background Bash has a configurable
  1-hour maximum; root commands have no such cap. Interactive PTYs are unchanged.

A shell is never path-confined: Bash can reach anything the OS user can, and
granted folders do not change that. Path checks protect the file tools, not
the shell. A `tools/rewrite` guard
(`src/harness/guard/`) can block or force-ask risky Bash commands by content
(preset groups + custom rules, workspace-scoped and Mode-independent — see
`docs/harness.md`). Its normalization joins only unquoted backslash-newline
continuations and strips comments separately on every LF/CRLF line before
whitespace collapse, so a comment cannot hide executable text on a later line;
quoted continuations remain content boundaries, and quoted or escaped hashes
remain literal.

The guard is not a shell parser or OS sandbox. Documented non-matching fixtures
include quoted executable names, command substitutions (`$(...)`), heredocs,
commands run through interpreters, and Windows-shell syntax; general obfuscation
can also bypass it. A matching custom substring `allow` exempts the whole
normalized compound command, including later commands. Use narrowly anchored
custom patterns; per-command exception handling is deferred.

## The Skill tool (`src/web/server.ts`, service in `src/harness/skills/`)

`Skill` loads one workspace skill's instructions **on demand** — there is no
classifier and no auto-load:

- **Layered catalog**: each workspace keeps an ordered list of source rules
  (`<data-dir>/workspaces/<id>/skills/sources.json`; Settings → Skills →
  Source folders). Rule kinds: `project` (a folder relative to the session's
  bound project, contained inside it), `workspace`
  (`<data-dir>/workspaces/<id>/skills`), and `absolute` (an absolute folder;
  `~` expands; saving an ENABLED rule that is a drive root, the home
  folder, or any ancestor of it is refused — case-insensitively on macOS and
  Windows; such a rule already stored keeps the rest of the list and is just
  skipped). Defaults: `.claude/skills` > `.agents/skills` >
  workspace > user (`userSkillsDir`; the web bin passes `~/.claude/skills`).
  The bundled layer (`bundledSkillsDir`) always rides last. The first layer
  holding a name wins — the catalog, `Skill` load, the settings tree, and
  agent-definition `skills:` preloads all resolve through the same layers.
  Note the default puts a project's own folders FIRST: a repository can
  override a workspace/user skill of the same name in its sessions (Settings
  marks such project rows); reorder the rules to change that.
- **Names**: a skill is a kebab-case folder (`[a-z0-9][a-z0-9-]{0,63}`)
  holding `SKILL.md`; other folder names are neither listed nor loadable.
  Lookup uses the folder name, the frontmatter `name:` is only the title.
  `sources` is reserved for new workspace skills (it is the rules route).
- **Writes**: only the workspace folder is writable (save/delete via the
  API); every other layer is read-only. A save reports `warnings` when the
  workspace rule is disabled or a higher layer/project owns the name.
  Skill-file previews resolve symlinks and refuse targets outside the skill
  folder.
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
tool, six actions — `spawn` (returns a handle at once), `wait` (blocks on
several children, capped at 120 s, honours Stop), `list`, `cancel`, `reconcile`,
`catalog`:

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
- **`uncertain` is retained, not failed**: when the parent's lifecycle append is
  rejected and canonical storage cannot be read to prove whether it landed, the
  child reports `uncertain` — asserting neither failure nor rollback. A
  spawn-`uncertain` child never launches; a result-`uncertain` child loses its
  advertised result but keeps its log. Either way the child is retained and
  keeps holding its capacity slot until settlement proves a durable parent
  result — or proves the spawn never landed and cleans it up. The status is
  stable across a restart: a child whose own log holds a terminal turn but
  whose parent carries no durable result still reads `uncertain`, never an
  invented terminal outcome. `reconcile`
  (`childIds` required, this conversation's children only) settles against
  canonical storage: a durable parent result wins outright; otherwise a
  canonical child terminal turn feeds one parent result record written through
  a usable parent writer, and the child settles only once that record is
  committed. Without that proof it stays uncertain, and a failed append is
  never retried through a poisoned session. The lifecycle lives in
  [the harness notes](harness.md#delegation-agents-tool-in-srcwebagent-delegationts).
- **Inherited context is opt-in**: `inherit: "brief"` also hands the child up
  to 12 000 chars of this conversation's recent user/assistant *messages* —
  never tool calls, tool output or a compaction summary — captured at spawn,
  wrapped as lower-trust `parent-context` data, and dropped (with a manifest
  omission) under budget pressure before history is. Only its hash and size are
  stored; the spawn result reports the size. `references` are unaffected and
  still ride in the brief.
- **Asynchronous on purpose**: a step runs its tool calls in sequence, so
  `spawn` must return immediately for children to overlap. Spawning is
  uncapped — no per-conversation, host, or per-turn ceiling; the spawn result
  reports the conversation's active-child count.
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
- **No authority gained**: a child's own calls re-enter the owning root's live
  mode exposure and approval policy. Its immutable admission ceiling is pinned
  at spawn as admission exposure ∩ role tools ∩ explicit grant; later mode
  widening cannot add tools, while later narrowing denies unstarted calls.
  `Agent` is `ask` only in *Ask before changes* and `allow` in Plan, *Edit
  automatically*, and *Full access*. Chat exposes it nowhere.
- **MCP exposure is a mode property** (`mcpExposure: none | read-safe | all`),
  so a duplicated Plan keeps it. `read-safe` exposes an MCP tool only when the
  server has a non-empty explicit allowlist entry for it AND its name matches
  the read-safe heuristic (`read|get|list|search|query|fetch|inspect|describe`);
  this is not proof that the remote implementation is side-effect-free. When
  the field is absent it is derived: a zero tool ceiling is always `none` (an
  explicit value cannot reopen it); Plan and any mode exposing none of
  `Write`, `Edit`, `Bash` get `read-safe`; everything else gets `all`. Bundled
  Plan sets `read-safe` explicitly; the other bundled modes derive `all`.
  **Behavior change (2026-10):** custom modes that cannot write/edit/run a
  shell — including conversations already stamped with such a mode — lose
  mutating MCP tools at their next request; add `mcpExposure: all` and
  reselect the mode to opt back in.
- **Grants only narrow**: a `grantTools` entry the role lacks is reported back,
  never silently dropped.
- **Four bundled roles**, each described by when to pick it and each stating
  the shape of its final report: `explorer` (find and explain; read-only),
  `worker` (one bounded, agreed task; file edits plus `Bash`, `BashOutput`,
  and `KillShell` for relevant checks), `reviewer` (find defects; read-only)
  and `verifier` (run tests/typecheck/build and judge; shell lifecycle tools,
  no source edits).
  Worker shell access still obeys mode/policy and narrowing spawn grants;
  its instructions prohibit scope expansion and unauthorized destructive,
  dependency, or commit/push operations (these are not shell sandbox guarantees).
  Workers report changed files, checks and outcomes, and incomplete or blocked work.
  `catalog` also lists the workspace's valid custom roles; copy a
  bundled role in Settings → Agents to customize it.

## File-based memory (`src/harness/memory/service.ts`)

When the selected mode enables both memory sources, the workspace and current
project `MEMORY.md` indexes are loaded as bounded untrusted reference; no
conversation is auto-extracted. Their absolute roots are advertised to the
model. Use `Read`, `Glob`, and `Grep` with an explicit memory-root path to browse
Markdown; `Write` and `Edit` can maintain `.md` topics and indexes with normal
file observation/conflict checks. Memory grants do not permit browsing the rest
of application storage, sensitive subdirectories, symlink escapes or foreign
scopes. Explicit denies and child role ceilings still apply. The old dedicated
MemorySearch/Read/Create/Update/Forget tools are not registered for model calls;
settings CRUD remains available for compatibility.

## The TodoWrite tool (`src/harness/tools/todo.ts`)

One stateless, root-free tool that maintains the session's task list,
Claude-Code-style:

- **Full replacement**: every call carries the COMPLETE list
  (`todos: [{ content, status, activeForm }]`, statuses `pending |
  in_progress | completed`); an empty array clears the list. Cap 100 items;
  invalid shape throws into a failed `ToolResult` the model corrects.
- **State IS the durable log**: the last successful `tool/call` named
  `TodoWrite` (paired with an `ok` `tool/result`) holds the current list. No
  registry, no extra event kinds, and a restart rehydrates the list from the
  log snapshot for free. The web derives it in `web/lib/todos-view.ts`.
- **Per session**: a subagent child has its own list; it never appears in the
  root's UI. Behavioral rules (exactly one `in_progress`, mark completed
  immediately, blocked → add an unblock task) live in the tool description
  and the default base prompt as guidance — the tool validates shape only.
- **UI**: the EnvironmentPanel's Tasks section + collapsed-capsule chip, a
  quiet transcript row (`N tasks`, `x done · y in progress`), and
  `Working · <activeForm>` on the TaskStatus line. Compaction may summarize
  older calls away, so the model can lose sight of an old list — accepted
  for v1 (context re-injection is a follow-up).

## MCP tools (`src/harness/mcp/`)

Servers from a workspace's `mcp.json` register dynamically as
`mcp__<server>__<tool>`:

- **Naming**: the `mcp__<server>__<tool>` namespace is reserved-protected —
  no MCP tool can shadow a built-in identity (`Read`, `Skill`,
  ...), and the built-ins cannot be re-registered by a server.
- **Workspace isolation**: one connection per (workspace, server); two
  workspaces pointing at the same server name get separate connections, and
  dynamic schemas are workspace-scoped.
- **Permissions**: the selected mode's `permissionDefaults` are the only
  permission map. Lookup is exact name, then `mcp__server__*`, then catch-all
  `*`, then `defaultMode`. `--yolo` maps asks to allows but preserves explicit
  denies. Host `blockedTools` can never be widened. A tool annotated
  `requiresUserInteraction` **always asks**, regardless of the selected mode.
  Bundled **Full access** sets the `*` catch-all to `allow`, so its MCP tools
  run without asking; modes without an MCP/catch-all entry leave every
  `mcp__*` name on the `defaultMode` (`ask`) fallback — that is the intended
  ask-by-default, not a bug.
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
use hash-checked writes. Saving a mode file is save-only: it does not change
roots that already hold a stamped snapshot of that mode. Selecting a mode for a
root is live: request assembly re-resolves the selected mode at the next model
request, and tool exposure/permission re-resolves at the next unstarted tool
gate. Existing children keep their pinned admission maximum, so widening a root
mode cannot widen them.

## Where they are mounted

- **Headless CLI** (`src/bins/headless.ts`): `fsTools()` plus `bashTool()`,
  with the root resolver granting the session's project root and denying the
  app's own data directory.
- **Web host** (`src/web/server.ts`): the same pair, with the root resolver
  reading the ambient agent scope — a session bound to a project gets that
  project's folder; a workspace-mode session with no project has **no
  filesystem grant** except enabled memory roots. `Skill` and `TodoWrite`
  register with the harness; MCP tools register per workspace as its servers connect.

## Reading further

- Filesystem tool tests: `tests/capabilities/fs-tools.spec.ts`.
- Bash tool tests: `tests/capabilities/bash.spec.ts`.
- Skill/memory/MCP tool behavior: `tests/harness/g3-context.spec.ts`,
  `tests/harness/g4-agents.spec.ts`, `tests/harness/g5-mcp.spec.ts`.
- TodoWrite tool + mode exposure: `tests/harness/todo-tools.spec.ts`,
  `tests/harness/todo-mode-exposure.spec.ts`; web derivation and UI:
  `web/lib/todos-view.spec.ts`, `web/components/chat/environment-panel.spec.tsx`.
