# The web host

The web host exposes the harness over HTTP. When `controlPlaneAuth` is on, privileged routes answer 401 until a single-use pairing code is redeemed; cookie mutations also need the CSRF header and the canonical Origin. It is off by default — the listener is loopback-only, so a local run already reaches no further than this machine's user; `--auth` turns it on for a port shared beyond that user. `createWebServer()` boots a fresh
kernel, mounts the harness services, registers the provider and tools, attaches
an approval policy whose answerer routes questions over SSE, and serves the
built React client.

```
src/web/server.ts   HTTP server: REST + SSE + approval bridge
web/                React client (stateless, renders from the event stream)
web-dist/           Vite build output (gitignored, produced by npm run build:web)
```

## Compaction lifecycle

Manual and automatic maintenance reserve a session before hooks and attachment
snapshot loading. Accepted messages remain ordered in the durable inbox, with
no model execution overlapping summary work. Stop, deletion and shutdown cancel
owned requests and do not automatically resume queued inputs. Summary requests
have no tools and use configured logical-request first-progress/idle/total
limits and provider admission. Each chunk must end in a valid settled stop.
Text attachment content is bounded as in normal context; image/file references
are disclosed without claiming unseen image content.

A successful canonical `compaction/end` authorizes history replacement;
checkpoint JSON is validated, atomic derived cache and may be rebuilt on the
next request. Four covered tail turns are optional raw duplication by default;
zero disables duplication, not uncovered history, and budget fitting may reduce
the covered tail by whole turns with omissions. The manifest remains the last
real request until another request consumes the checkpoint. Headless automatic
integration and stronger power-loss durability guarantees are not claimed.

## The client is stateless by design

The browser client holds **no model state of its own**. The transcript is
projected from the durable session events streamed over SSE — a fresh connection
first receives a **snapshot** of the whole log (server-compacted: raw content
chunks of finalized steps and `context/body` payloads never ship; reasoning
folds to one event per step), then live `session/event`
frames. Approval questions arrive on the same stream as `approval` envelopes,
and answers go back over one POST. This is the "render from `session/event`"
principle: the log is the single source of truth, and any client can rebuild the
UI from it at any time.

## Workspace interaction

- An empty workspace offers **New conversation**. Until a session is selected, its connection state is idle, not connecting.
- Project binding is fixed when creating a session. Project registration is in Workspace settings, reached through New Conversation → Manage projects. Unbound sessions explain that file/shell work needs a project-bound new session.
- Modes load with the initial workspace metadata and on workspace switches. Navigation generations and request tokens reject obsolete initial loads, mutation completions, lists and model/mode refreshes, including workspace A → B → A transitions.
- Drafts, pending-send flags and send errors are keyed by workspace/session in memory. A submitted draft clears only after the server accepts the POST and only if its edit revision is unchanged. Failures remain inline with details and provider guidance; automatic resend is deliberately avoided because a lost response does not prove the request was rejected.
- Approval questions are deduplicated and reconciled against durable request, decision, tool-result and turn-end events on replay, and removed after a successful answer.
- Model menus offer search for larger lists, provider grouping, keyboard navigation and full wrapping option labels. Popups portal into document.body with viewport-clamped positioning and scroll/resize updates; Escape belongs to the popup before a drawer or modal.
- Model and thinking level are **per-conversation controls**, backed by the session's durable preference (`GET/PUT …/:wid/sessions/:id/model`). The client caches them per workspace+session, serializes partial writes per conversation, and never substitutes defaults while a conversation's controls are loading or failed: the composer blocks sending with a status hint and offers a Retry refetch on failure. With no conversation selected the same pickers edit the **global default** (`/api/model-defaults`) that future sessions snapshot.
- The sidebar docks at 768px and above (its collapsed state is remembered); below that it is a modal drawer with a scrim, Escape handling, focus containment and focus restoration. Settings tabs use arrow/Home/End navigation, roving tabindex and linked tabpanels. Provider edits survive tab changes; close/provider changes request discard confirmation, including pending model text.
- Tool rows are lines of text, not boxes: one line names what ran and what it acted on, and only a row with something to show opens — into one shared frame (rule above and below, faint fill) that presents a command as a terminal, a change as the Git panel's diff, and anything else as its result. The exact arguments stay one click away under "View call details". Transcript identities are explicit (right-aligned user bubbles, plain assistant prose).

### Production task workflows

- **New conversation** and Ctrl/Cmd+N clear the canvas without creating a session. The composer's scope chip picks an existing project, a newly chosen folder, or **Chat only**; the session is created by the first sent message, and a failed first send keeps the draft.
- The sidebar footer owns workspace selection; the sidebar also groups project history and search. History filters only affect navigation, never a session's immutable execution project. Subagent conversations are not top-level rows: a **running** child (or the child being viewed) nests under its parent conversation as a branch-icon row — running ones carry a spinner — that opens the child's own conversation, while ended children stay in the parent's Subagents workbench view; every parent conversation itself always keeps its row so its next prompt stays one click away. A search match on a shown child's title keeps the parent row visible so the nest stays reachable.
- The Context sheet starts closed at every viewport size. Context manifests load only while it is open. The main pane shows durable task lifecycle and separately explains event-stream connection loss. Queued/being-submitted inputs show preparing; open turns show running or waiting approval; terminal reasons remain visible. Partial assistant chunks stop appearing live at turn end.
- Composer is a contenteditable with inline chips: `@` lists files from the conversation's project (bounded search that never follows symlinks or walks hidden/`node_modules` trees) and inserts a mention chip rendered where the caret was; `/` at the start inserts a skill invocation phrase as plain text; `+` attaches a project file (reference chip) or an uploaded file (stored blob chip), and pasted/dropped images become attachment chips. Neither completion nor attachment grants a permission, reads a file, or pins a skill by itself. Both menus stay shut without a source, are driven from the contenteditable (a combobox with `aria-activedescendant`), and Escape closes them until the query changes. A mention chip carries the file's themed icon — the same glyph its picker row shows — and clicking it opens the file in the workbench Files tab. Removing a chip removes exactly that segment: the chip's remove button, or Backspace/Delete with the caret directly beside it; ArrowUp on an empty composer brings back the newest own message; unsent drafts (text plus chips) survive a reload.
- Composer context shows the fixed project path or an explicit no-project warning with a new-conversation CTA. “Chat-only” describes absence of a project, not a mode switch or a promise to disable every tool. Model and thinking controls belong to the conversation and apply at its next request (the no-conversation pickers write the global default for future sessions); the selected mode governs permissions at the next request/tool gate. Mode and server restrictions still apply.
- The thinking chip names the level the next request really carries, and changing the model re-resolves it: a saved level the newly selected model does not document is dropped from the request (that model's own default governs) and the chip reports it as ignored rather than showing a level the wire will never carry. The saved value stays in the conversation's log and applies again on a model that offers it.
- The composer footer is grouped by what each control decides, not by control type: attach and mode sit on the left, while the model and its thinking level — whose available levels come from that model — sit together on the right next to Send. The footer answers to the composer's own width (a container query, because the column is far narrower than the viewport with the sidebar open): one row when controls fit, otherwise two deliberate rows rather than a ragged wrap. When the row is tight the model name truncates and nothing else does, and it never truncates to nothing.
- Approval review exposes tool name, target, full escaped JSON arguments, call ID, conversation project and the window the request cancels itself in. **Allow once** and **Deny** answer only that pending request. It does not widen host `blockedTools`, mode exposure, or project root. A file path outside the granted folders shows `Outside granted folders: …`; on a root conversation the card may also offer **Allow `<folder>` for this session**, naming exactly the folder it grants.
- The composer's folder chip (`+N`) lists the extra folders the conversation's file tools can use — from project settings (Settings → Projects → **Extra folders**, read-only or read & write, other projects or any folder) and the conversation's own, which it can add or remove. Shell commands are not confined by these folders. Interactive MCP tools keep asking. Child-agent questions relay onto the parent conversation, labelled with the child's agent name and id. Buttons lock while submitting; failed submissions remain visible. Durable decisions remain in transcript history, including expiry/invalidation.
- The selected mode is the workspace's permission truth. Its `permissionDefaults` decide each tool; `--yolo` is stated on the trigger and maps asks to allows, but never lifts an explicit deny.
- Failed, cancelled, limited and interrupted work offers inspection-first recovery guidance. Unknown recovered tool results are explicitly called out. There is no automatic retry or replay control: inspect actual effects, then submit new instructions limited to remaining work.
- The Providers pane states each fact once. The provider name is its editable title (rename in place) with enablement as a state pill plus the opposite verb, and delete lives on that title row; the rail carries the name, the `default` marker and the enabled dot. A model row is one pill — id, `Vision` when it accepts images, its context window — with the provider-default radio and the global-default, edit and remove actions beside it. Per-model overrides open in **Edit model settings**, committed or abandoned as one decision: id (renaming carries its overrides), context window, input types — text is shown locked because every model takes it, image is a checkbox whose state is the effective one, with a link back to the catalog default once it is overridden — and thinking default. **Sync from /models** probes the endpoint and opens a selection: checked models are kept, unchecking one removes it, models the endpoint does not offer are left alone, and nothing is stored until Save.
- Settings distinguish global provider storage plus the global default model from workspace services. **Modes** sits after Projects in the Workspace group: its structured editor loads a workspace file into a form (name, optional description, instructions, context sources, tool exposure, the MCP tools ceiling — Default/None/Read-safe/All — and per-key permissions; the tool list is the harness's own `KNOWN_MODE_TOOLS`, and every server-valid field round-trips byte-for-byte), saves existing files with `expectedHash`, and offers Reload or an overwrite that first reloads the fresh hash after a conflict. Its catalog puts bundled read-only modes first (Duplicate only), then workspace modes (Edit/Delete); every row has an **In picker** switch that hides the mode from the composer picker until re-enabled, except the workspace's selected mode, whose switch is locked on (the server answers `409` to hiding it). It plainly lists each `permissionDefaults` key including `*` and MCP patterns. Mode authoring does not switch an existing conversation: each root owns its live selected mode, and a conversation mode switch applies at its next model request or unstarted tool gate. Workspace mode selection seeds new conversations and draft UI. Agent definitions are workspace-scoped; child listings are current-session-scoped. Saving configuration is not evidence of connectivity; provider connection checks use saved configuration rather than unsaved drafts.
- Automated workflow regressions cover scope validation, creation markup, durable lifecycle, stopped partial chunks, recovery guidance and approval arguments/decision rendering. Fixture-backed Chromium interactions, mobile layout, keyboard focus and all settings sections pass. Real-backend end-to-end workflows, native zoom and screen-reader acceptance remain separate gates.

## Starting it

```sh
npm run build:web   # build the React client into web-dist/ (one time)
npm run web         # serve at http://127.0.0.1:3082 (default port)
```

The web bin (`src/bins/web.ts`) accepts:

| Flag | Meaning | Default |
|---|---|---|
| `--port N` | HTTP port | `3082` |
| `--root DIR` | default workspace root | `process.cwd()` |
| `--yolo` | map selected-mode `ask` permissions to `allow`, while preserving explicit `deny` (host `blockedTools`, exposure, child ceilings, and interactive MCP still apply) | off |
| `--auth` | require control-plane pairing; the startup line then prints a single-use code (`DNT_HARNESS_AUTH=1` does the same, `--no-auth` overrides it) | off |

The server always boots even with no provider configured, so the Settings panel
can add one. A non-blank `DEEPSEEK_API_KEY` seeds a `deepseek` entry on first
boot when the provider config is empty; a blank or absent key does not. The
scripted mock provider is gone — without a usable provider, chat requests
answer `400` until one is configured.

## Provider configuration

Providers are stored as plain JSON in `~/.dnt-harness/providers.json`
(override with the `configFile` option). The file is a **versioned
envelope** holding the global provider list *and* the global default
model selection:

```json
{
  "version": 2,
  "defaults": { "provider": "deepseek", "model": "deepseek-chat", "thinkingLevel": null },
  "providers": [{
    "id": "deepseek",
    "name": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-…",
    "models": ["deepseek-chat", "deepseek-reasoner"],
    "enabled": true
  }]
}
```

Only the versioned envelope is accepted; any other shape loads as an empty
store, and a stale `defaultModel` field on a provider entry is ignored rather
than honored. Model choice is never stored per provider — a provider's
`models[0]` is just the first id it advertises, used only as a last-resort
fallback. All provider/default mutations run through one serialized,
persist-before-publish transaction.

Every endpoint speaks the standard `POST {baseUrl}/chat/completions` SSE wire
format (tool-call fragment accumulation, `reasoning_content` → thinking
deltas); DeepSeek is simply one such endpoint. API keys are masked when
serialized to the client (`keyMasked`), never returned raw. When the active
workspace carries a thinking level, the adapter adds the model's documented
reasoning control fields to the request body (see the model catalog section
below) — never a generic field for an undocumented model.

`apiKey` may be empty: local gateways often authenticate by other means, so a
keyless entry stays selectable and the `Authorization` header is omitted rather
than sent as an empty `Bearer`. Only `enabled: false` takes a provider out of
the picker.

## REST API

### Workspace-scoped routes (the primary surface)

Since G2, sessions are born into a workspace, and every durable resource is
addressed under `/api/workspaces/:wid/...`. Unknown workspaces fail closed
(`404`); ownership is re-checked per request, so a foreign id never leaks
data, and a workspace switch never changes a running turn's ownership or
tool root. The families, at a glance:

| Route family | Purpose |
|---|---|
| `GET/POST /api/workspaces`, `PATCH/DELETE /api/workspaces/:wid` | workspace list (with running/approval badges), create, rename, archive/restore, delete (empty only) |
| `…/:wid/sessions`, `…/:wid/sessions/:id` (+ `/events` SSE, `/messages`, `/stop`, `/steer`) | session lifecycle, streaming, queued messages, stop, steer. `/messages` answers 409 for a child agent session: children are executor-managed and cannot be resumed directly. See "Queue, stop, and steer" below |
| `GET/PUT …/:wid/sessions/:id/model` | the conversation's own model controls (model, provider, thinking level) — see the per-conversation model section |
| `GET/PUT …/:wid/sessions/:id/grants` | the conversation's extra file-tool folders: `GET` returns `{ revision, roots, effective }` (effective = project + session grants merged); `PUT { expectedRevision, roots: [{ path, access }] }` replaces the list — browser principal only, `409` on a stale revision or a conversation without a project, `400` for a folder the grant validator refuses (see `docs/capabilities.md`) |
| `…/:wid/sessions/:id/manifest`, `…/compact` | last real request's context manifest; manual compaction returns `{ coversSeq, summaryChars }`, with 409 for active/duplicate ownership. Automatic compaction uses fresh completed-turn pre-trim pressure in compact-history mode; the standard bin enables 0.85 (embedded default/explicit zero disables). PreCompact hooks share the reservation. |
| `GET/PUT /api/model-defaults` | the **global** default provider/model/thinking level, shared by every workspace: the pair new sessions snapshot at creation, the draft pickers' target, and the live fallback for legacy conversations without a snapshot |
| `PUT …/:wid/model`, `PUT …/:wid/thinking` | compatibility proxies: they verify workspace ownership, then mutate the **global** default above; new clients use `/api/model-defaults` |
| `PUT …/:wid/mode`, `GET …/:wid/meta` | workspace-local default mode control for new conversations and draft UI. Existing roots keep their own selected mode. The `GET …/mode` catalog lists **enabled modes only** (a disabled mode refused for selection answers `400`); `GET …/meta` returns the workspace default's `permissionDefaults`, `mode`, and `yolo` when enabled; it does not return a policy or effective-policy overlay. |
| `GET …/:wid/modes`, `GET/PUT/DELETE …/:wid/modes/:mid`, `POST …/:wid/modes/:mid/duplicate`, `PUT …/:wid/modes/:mid/enabled` | mode **authoring**, separate from workspace-default and conversation selection. The catalog carries each mode's `enabled` flag, `toolExposure`, and `permissionDefaults`; the single-mode read returns raw Markdown plus a hash, and `PUT` takes `{ content, expectedHash? }` (required when replacing an existing file). Bundled modes are read-only (`400`), a stale or missing update hash is `409`, and invalid content is rejected before anything is written. `PUT …/enabled` takes `{ enabled: boolean }`: it shows or hides a mode in this workspace's picker — bundled modes may be hidden too, disabling the workspace default is `409` (select another first), the disabled set persists beside the mode files, and saving a mode always re-enables it. `GET/PUT …/:wid/sessions/:id/mode` reads or switches one root's live mode; the switch is durable and governs its next model request or unstarted tool gate, including its children, without affecting sibling roots. |
| `…/:wid/projects` (+ `/projects/:pid`) | project binding: working folder, ownership, overlap rejection. `PATCH` also takes `additionalDirectories: [{ kind: "path", path, access } \| { kind: "project", projectId, access }]` (browser principal only, every folder validated); retargeting is `409` while any turn — this project's or another's through a grant — holds a write lease inside it |
| `GET …/:wid/projects/:pid/(files\|file\|search)` | read-only project browsing: one directory listing, one file body, and a bounded file-name search for composer mentions |
| `GET …/:wid/projects/:pid/media(?path=)` | stream one project file as renderable media for previews: images by magic bytes, audio/video by extension; anything else is 404. Honours single byte `Range` requests (seeking) and `HEAD`; capped at 64 MB; traversal refused |
| `GET …/:wid/projects/:pid/git(?path=)` | read-only git: status (branch, changed paths, added/removed counts) with no `path`, or one file's unified diff against HEAD (untracked files diff as all additions; a repository with no commit diffs the staged index). Not a repository answers an empty status; traversal is refused. Nothing is staged or written |
| `…/:wid/terminals` (+ `/events` SSE, `/:tid` DELETE, `/:tid/(input\|resize)`) | interactive Workbench terminals: PTY lifecycle, one multiplexed output stream per workspace — see the terminal section |
| `POST …/:wid/attachments`, `GET …/:wid/attachments/:id` | composer attachments: upload (content-addressed by sha256, verified media type) and serve (immutable, workspace-scoped) |
| `…/:wid/agents/:name` (GET resolve / DELETE), `POST …/:wid/agents/:name` | agent definitions; POST spawns a bounded child from `task: { prompt, requiredResult }` or the four-field `task: { objective, constraints, references, requiredResult }`, optionally `inherit: "brief"`, `model` (`provider:model`) and `grantTools`. 202 with the handle (+ `inheritedChars`, `note`); an empty brief, a bad `inherit`, or a role that refuses inheritance is 400 |
| `GET …/:wid/agents(?projectId=)` | every effective subagent: bundled, `~/.claude/agents`, the workspace layer and the project's `.claude/agents`; each row carries `source`, `path`, `overrides`, `definition.warnings` |
| `POST …/:wid/agents/:name/import` | save a Claude Code subagent file verbatim into `<ws>/agents/<name>.md` (`dialect: "codex"` converts a pinned Codex spec first) |
| `GET …/:wid/agents/children?root=…`, `GET/DELETE …/:wid/children/:childId` (+ `/cancel`), `POST …/:wid/sessions/:parentSessionId/children/:childSessionId/reconcile` | child list / wait-result / cancel / settlement; statuses may include `uncertain`, which is stable across restarts until settled — repair runs through the Agent tool, the Workbench's Retry settlement, or the reconcile route (below); the legacy `POST /api/sessions/...` reconcile address is retained |
| `…/:wid/mcp` (+ `/:server` GET/POST/DELETE, `/:server/(enable\|disable\|reconnect)`, `/mcp/import`) | MCP server lifecycle, stored config for editing, deletion, and imports with provenance |
| `GET/PUT …/:wid/hooks(?projectId=)` | Claude Code hooks: GET returns the workspace layer's `hooks` section of `<ws>/settings.json` plus every applying layer (`sources`, `effective`, `diagnostics`); PUT `{ hooks, disableAllHooks? }` replaces that section and keeps other settings keys |
| `…/:wid/secrets(/:key)` | encrypted secret management (masked responses) |

Approval answering stays transport-global at `POST /api/approvals/:id`
(below) — approval ids are unguessable capabilities, not session-scoped
sequences.

### `GET /api/fs/dirs`

Directory browser backing the client's folder picker. A browser never
reveals a chosen folder's absolute path, so the web host lists **directory
names only** (never file contents) and the picker navigates real folders:
`?path=` (default: the server user's home) returns the canonical path, its
parent (`null` at a filesystem root; on Windows a drive root also lists the
machine's other drives as rows), and the case-insensitively sorted child
directories — symlinked folders included, broken links skipped.
Non-directories and unreadable paths answer `400`.

The unscoped routes documented below (`/api/meta`, `/api/model`,
`/api/folder`, `/api/sessions…`) are **legacy**: they exist only for
memory-mode hosts without the workspace model and resolve through one
implicit workspace. New clients use the workspace-scoped families.

Memory is stored as workspace and project Markdown topic files under the
application home's `workspaces/<id>/memory/{workspace,projects/<project-id>}`.
On an enabled request, existing `MEMORY.md` indexes (at most 200 lines and
25 KiB each) are wrapped as untrusted reference; topic bodies are only read
through ordinary Read/Glob/Grep file tools. Write/Edit may access only Markdown
inside the current scope's memory roots; path-jail and explicit denial still
apply. The five legacy Memory* tools are not registered. The existing memory
REST/UI edits the same Markdown files; the old pinned flag is metadata only.
Memory switches in a mode must both be on for indexes and file access.

### Legacy: `GET /api/meta`

Active provider/model pair, the default workspace, and the safely masked
provider list for the Settings panel.

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "folder": "/workspace",
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "providers": [{ "id": "deepseek", "name": "deepseek", "enabled": true, "keyMasked": "••••abcd", "models": ["deepseek-chat"] }]
}
```

### Legacy: `PUT /api/model`

Select the active provider and model. The model selector rides the
**`agent/request` seam**: every step's request is stamped with the selected
model before the provider sees it.

```json
// body
{ "model": "deepseek-reasoner" }
```

`400` when the name is not in the provider's offered models.

### Legacy: `PUT /api/folder`

Re-scope the workspace the filesystem/bash tools are confined to. The tools are
registered with **live accessors** (`() => state.folder`), so this just flips a
variable — no re-registration, and the change applies to the next tool call.

```json
// body
{ "path": "/some/directory" }
```

`400` when the path is empty, missing, or not a directory.

### `GET /api/usage`

Token statistics behind **Settings → Usage**, which sits in the Global group and covers every workspace. Each completed model request appends one line to `<home>/usage.jsonl`. A line carries `v`, `at`, `startedAt`, `workspaceId`, `sessionId`, `rootSessionId`, `kind` (`turn` / `child` / `compaction`), `provider`, `model`, `input` (cached prompt included), `cached`, and `output`. A request whose provider reports usage more than once is recorded with the last report. A stream that ends without any usage report records nothing. The host rebuilds a `day × model` index from that file at boot. Malformed or truncated lines are skipped. A failing append logs one warning and never affects the turn. Usage before this log existed was never stored, so it cannot be backfilled.

The response is `{ days: [{ date, model, input, cached, output, requests }], longestSessionMs, firstRecordAt?, today }`. `days` covers the last 371 host-local days. `today` is the host-local date, so the client never guesses the timezone. `longestSessionMs` is the longest block of activity per root conversation, with child agents folded into their root, after merging gaps of 30 minutes or less. The panel derives everything else in `web/lib/usage-stats.ts`:
- totals and the peak day (input + output);
- the current and longest streaks (an empty today does not break the current streak);
- a 53-week heatmap with Sunday-first columns in Daily, Weekly, or Cumulative mode, coloured by quantile levels;
- a 7- or 30-day trend with one monotone curve per model (top 7 plus "Other").

### `GET/PUT /api/image-generation`

The provider/model pair behind **Settings → Providers & Models → Image generation**, used by the `GenerateImage` and `EditImage` tools (see `docs/capabilities.md`). The body and response are `{ provider, model }`, both strings, or both `null` when the feature is off. `PUT` answers `400` for an unknown provider id or a half-filled pair. The pair is stored in `image-generation.json` beside `providers.json`; the key and base URL stay on the provider entry.

### `GET/PUT /api/image-understanding`

The dedicated multimodal chat pair behind **Settings → Providers & Models → Image understanding**. `DescribeImage` uses it when the active chat model has effective `vision: false`. Body, validation, persistence, and provider references match `/api/image-generation`, but this model must accept image input through chat completions rather than an Images generation endpoint. It is stored in `image-understanding.json` beside `providers.json`.

### `GET /api/providers`

List configured providers with masked keys: `[{ id, name, baseUrl, enabled, keyMasked, models, modelSettings? }]`.
`modelSettings` carries per-model operator overrides —
`{ [model]: { contextTokens?, vision?, thinkingLevel? } }` — as edited in the
Settings provider panel (legacy `contextLimits` files migrate into it on load).

### `POST /api/providers`

Create a provider. Body: `{ name, baseUrl, apiKey?, models?, modelSettings? }`. `name` and
`baseUrl` are required and `baseUrl` must be http(s); `apiKey` is optional
because local gateways often accept no credential (the `Authorization` header
is then omitted entirely rather than sent as an empty `Bearer`). `201 { id, … }`.

### `PATCH /api/providers/:id`

Update fields: `{ name?, baseUrl?, apiKey?, enabled?, models?, modelSettings? }`.
Omitting `apiKey` keeps the stored secret. A present `modelSettings` **replaces
the whole map** (an empty object clears every override). `404` on an unknown id.

### `DELETE /api/providers/:id`

Remove a provider. Deleting or disabling the active provider repoints the
active pair to the first remaining usable one. `404` on an unknown id.

### `POST /api/providers/:id/test`

Fire one buffered completion ping. Body `{ model? }` names the exact model to
ping — this is how the Settings model list verifies one row — and an
unadvertised id is `400` rather than a misleading upstream `404`. Without a
body the provider's first advertised model stands in, falling back to `test`
when it advertises none yet, so a freshly added provider can check its endpoint
and key before any sync. `200 { ok: true }` or `502 { ok: false, error }`.

### `GET /api/providers/:id/models`

Ask the endpoint what it offers and **store nothing** (accepts OpenAI
`{ data: [{ id }] }` and bare arrays). `200 { ok: true, models }`, `404` for an
unknown provider, `502` when the endpoint fails or answers an empty list.

This is what the browser's **Sync from /models** uses: the answer is a proposal
the operator selects from, and the selection saves through the ordinary
`PATCH /api/providers/:id` with everything else on the form. A list nobody
confirmed can never replace the stored models.

### `POST /api/providers/:id/sync`

`GET {baseUrl}/models` and store the whole result as the provider's model list,
in one request. `200 { ok: true, models }`. Kept for REST clients that want the
unattended behavior; the browser uses the probe above instead.

### Model catalog, context budget, and thinking level

The shared catalog (`src/harness/llm/model-catalog.ts`, bundled by the web
client too) holds verified capabilities for exact model IDs — context window,
vision, reasoning controls — plus narrowly-scoped family patterns for dated
variants and gateway namespaces (`openai/gpt-5.6`).

**Context budget** resolves per request: an operator `contextTokens` override
makes the budget *verified*; otherwise the catalog's documented window
(exact ID → known family → **256k default**) applies as a labeled estimate.
`GET …/:wid/meta` never guesses — unknown models fall back to the default.

**Thinking level** is a global default control (`PUT /api/model-defaults` with
`thinkingLevel`, or the compatibility `PUT …/:wid/thinking`, body
`{ "level": "off|minimal|low|medium|high|xhigh|max" | null }`; `null`
returns to the model's configured default; a per-model `thinkingLevel`
default may be set in `modelSettings`). A conversation's own preference
(below) overrides it, and an explicit `null` there deliberately falls
through to the model's configured default — never back to the global
override. The level rides the request as
host-stamped metadata and the completions adapter translates it into the
model's **documented** fields only (`reasoning_effort`, `thinking:
{type}`, `enable_thinking`, extended-thinking `budget_tokens` for gateway
Claude aliases) — unsupported pairs send nothing rather than risk a 400.

### Per-conversation model: `GET/PUT …/:wid/sessions/:id/model`

Each conversation owns its model/provider/thinking-level choice as durable
`session/model` events in its log, so it survives restarts and replay.
`POST …/:wid/sessions` **snapshots** the global default at creation;
afterwards the conversation is independent — later `PUT /api/model-defaults`
(or the compatibility `PUT …/:wid/model` / `PUT …/:wid/thinking`) changes
apply only to future sessions (and to legacy conversations created before
snapshots existed, which keep inheriting the live global defaults; the
`source` field below distinguishes the two).

`GET` answers the **effective** controls:

```json
{ "provider": "deepseek", "model": "deepseek-chat", "thinkingLevel": "high", "source": "session" }
```

`source` is `session` when the conversation owns a preference and
`global` when it is inheriting. Unconfigured fields are `null`.

`PUT` takes a partial body — `{ "provider"?, "model"?, "thinkingLevel"? }`,
each `string | null`, at least one required:

- An **omitted field keeps its previous value**; a `null` is an **explicit
  session-owned value**, never a request to re-inherit global defaults.
  `provider: null, model: null` deliberately blanks the pair and rejects
  sends; a one-sided resulting pair is `400`. `thinkingLevel: null` returns
  to the selected model's configured default (never the workspace thinking
  override).
- A resulting non-null provider/model pair is validated against the provider
  catalog before anything is written; an explicit blank pair is accepted
  without executable-pair validation. `400` covers an unknown/partial pair
  or invalid thinking level, `404` an unknown session, and archived
  workspaces refuse writes.
- The event append is a durability barrier. If persistence fails, the
  session is **fenced**: subsequent model reads and messages answer `503`
  until a host restart reloads canonical history — uncommitted state is
  never served or executed.

### Global defaults: `GET/PUT /api/model-defaults`

One selected provider/model/thinking level shared by **every** workspace —
provider configuration is global, and so is the default selection. The pair
is persisted in the versioned provider store (v2 envelope: `defaults` +
`providers`) and survives restarts; there is no per-workspace model state to
reconfigure after creating a workspace or rebooting the host.

```json
// GET
{ "provider": "deepseek", "model": "deepseek-chat", "thinkingLevel": null }
```

`PUT` accepts the same shape (`null` provider/model is an explicit blank
that blocks sends; a partial pair is `400`). Every write runs inside the
serialized provider-store transaction and is published only after the disk
commit succeeds, so a failed write leaves providers, defaults, and runtime
registrations untouched. Provider create/patch/delete/sync repair the
default in the same transaction: a deleted/disabled provider or a removed
model falls back to the next enabled provider's first advertised model; with
no usable provider the default is explicitly blank.

The global pair doubles as the "model last chosen" pointer: adopting a
provider/model in any conversation — or setting it explicitly — repoints the
global default to that pair, so the next conversation opens on the model the
operator was just using and never re-picks for them. A thinking-only edit does
not repoint it, because a thinking level is conversation-scoped rather than a
global preference. Selecting a provider in `PUT /api/model` (or a workspace
model route) requires an explicit `model`: an inferred model would silently
run and bill something the operator never named.

`GET …/:wid/meta` returns the same global pair to every workspace, so the
client's no-conversation pickers target `/api/model-defaults` directly.

Resolution happens per model request through `agent/request`: a change lands
on the **next request of a running turn** without interrupting the in-flight
stream, and the context budget is recomputed for the new model on that same
request. Each `assistant/message` records the pair that actually served it
in its `controls`, so the log answers "what did this reply come from".


### Legacy: `GET /api/sessions`

List sessions: `[{ id, title, eventCount, folder }]`. `folder` is the
session-scoped workspace or `null` when the session inherits the server default.

### Legacy: `POST /api/sessions`

Create a session and bind an agent to it. Optional `{ folder }` sets a
session-scoped workspace (must exist and be a directory). `201 { id, folder? }`.

### Legacy: `PUT /api/sessions/:id/folder`

Set this session's workspace; `{ path: "" }` resets it to inherit the server
default. Tools resolve their root through the **ambient agent scope**, so two
sessions can work in different folders concurrently without cross-talk.
`200 { folder }` / `{ folder: null }` on reset.

### Queue, stop, and steer

Three ways to act on a running conversation. All acceptance is durable
(`input/queued`) before anything is stopped or run.

| Action | Route | Running turn | Queued input |
|---|---|---|---|
| **Queue** (Enter) | `POST …/messages { content }` | finishes normally | the next turn claims all of it |
| **Stop** | `POST …/stop` | closes `turn/end: cancelled` | stays queued — never auto-runs, including input sent while the stop settles |
| **Steer** (Ctrl/⌘+Enter, Steer button) | `POST …/messages { content, delivery: "steer" }` | closes `turn/end: steered` | old queue + the new message run in one new turn, oldest first |
| **Send now** (on the queue strip above the composer) | `POST …/steer` | closes `turn/end: steered` | the whole queue runs in one new turn |
| **Edit** (pencil on a queued row) | `PATCH …/inputs/:inputId { content }` | untouched | same id and position, new text (`input/revised`) |
| **Delete** (trash on a queued row) | `DELETE …/inputs/:inputId` | untouched | removed; `input/settled { outcome: "withdrawn" }`, never runs |

- `delivery` defaults to `"queue"`; anything else answers `400`. The reply is
  `202 { inputId, queued, delivery }` (`queued` is true for queue-delivery
  behind a running turn, or either delivery during compaction maintenance).
  Maintenance adds `dispatchBlocked: "maintenance"`; acceptance is durable but
  no turn has been dispatched. A steered input is recorded with
  `delivery: "steer"` on its `input/queued` event.
- The host, not the client, decides how a new message renders. When the
  session is idle and nothing blocks dispatch (no compaction, no uncertain
  transport, not closed), `input/queued` carries `runsNow: true` and the UI
  shows it at once as a sent user message in the transcript. Without the stamp
  the input waits behind a turn and shows only on the queue strip above the
  composer. A `runsNow` input that a `turn/end` finds still unclaimed falls
  back to the queue strip.
- Steer stops like Stop does — the provider stream, cancellable tools, pending
  approvals, and child agents — and only then runs the queue. A tool that cannot
  be cancelled delays it until it returns.
- Checks run before anything stops: a duplicate `clientRequestId` returns
  `200 { duplicate: true }` and does **not** stop the turn again; `429`
  (pending-input bound), `400`, `503`, and a failed durable write leave the
  running turn untouched.
- `POST …/steer` with nothing pending is `200 { steered: false, pending: 0 }` —
  never a hidden Stop. Otherwise `202 { steered: true, pending }`. During
  compaction it instead returns `202 { steered: false, queued: true, pending,
  dispatchBlocked: "maintenance" }`. Idle, it simply runs the queue.
- Not durable as an intent: if the host restarts before the steered turn
  starts, recovery closes the open turn as `interrupted` and the input is plain
  pending input again (it does not auto-run).
- Edit/Delete answer `200 { inputId, revised: true }` / `200 { inputId,
  withdrawn: true }`; `404` once the input is no longer pending (already ran
  or deleted), `409` once a turn claimed it (pre-step or later), `400` for an
  edit to empty text without attachments. The live inbox and the log change in
  the same tick, so a turn sees either the old or the new queue.
- Each accepted input ends with `input/settled { outcome: admitted | rejected |
  empty | withdrawn }`. A pre-step rejection (hooks, MCP configuration) settles it as
  `rejected` without a `user/message`; the UI shows the bubble as "Not sent".

### Legacy: `POST /api/sessions/:id/messages`

Queue a user message and fire the agent loop.

```json
// body
{ "content": "hello" }
```

Returns `202 { queued: true }` immediately — the reply (and any failure, which
closes the turn durably) reaches the client through the SSE stream. `400` on an
empty content, `404` on an unknown session.

### Legacy: `DELETE /api/sessions/:id`

Delete a session: it leaves the listing, its SSE streams end themselves with an
`error` envelope (`session deleted`), and later requests answer `404`.

```json
// response
{ "deleted": true }
```

### Legacy: `PATCH /api/sessions/:id`

Rename a session with a custom title; an empty title resets to the derived one
(truncated at 80 chars, trimmed).

```json
// body
{ "title": "my favorite chat" }
```

```json
// response
{ "id": "...", "title": "my favorite chat" }
```

`400` on a non-string title, `404` on an unknown session.

### Legacy: `POST /api/sessions/:id/stop`

Ask the in-flight turn to stop. The agent's chunk loop notices the abort between
stream events and closes the turn durably with `turn/end: { reason: "cancelled" }`
— a result, not a failure. Queued input stays queued (see "Queue, stop, and steer").

Returns `202 { stopped: true }`; a no-op while idle. `404` on an unknown session.

### `POST …/:wid/sessions/:parentSessionId/children/:childSessionId/reconcile`

Explicit settlement for a child retained after a durable lifecycle
acknowledgement was lost. The workspace id scopes the lookup and the parent id
remains part of the address, so the route can only reconcile a child of that
parent: an unknown parent, or a child of another parent in the same workspace,
answers `404`. Settlement is canonical — a durable parent result wins outright;
otherwise a canonical child terminal turn feeds one `agent/child-result`
record written through a usable parent writer, so a child whose live writer is
poisoned may stay `uncertain` until a restart replaces it. `200` with the
settled handle, or `200 { reconciled: true, child: null }` when a
never-launched spawn was proven absent and removed. The child's capacity slot
is held until one of those outcomes (or root deletion).

The legacy address `POST /api/sessions/:parentSessionId/children/:childId/reconcile`
is retained with the same contract and answers, but resolves the parent
through the implicit workspace like every other legacy route. The Workbench's
Retry settlement POSTs the workspace-scoped address.

### `POST /api/approvals/:id`

Answer a pending approval question.

```json
// body
{ "allow": true, "scope": "once" }
```

`scope` defaults to `"once"`. `"session"` is accepted only with `allow: true`
on a root conversation's out-of-grant question that carries a
`proposedGrant`: once the call is finally allowed, that folder is appended to
the conversation's `session/grants` (with the call's read/write access) right
before the call runs. Anything else is `400`.

`200 { answered: true }`, or `404` if the approval was already answered
(answered approvals are removed from the pending map). Approval envelopes may
carry `scopeWarning` and `proposedGrant` beside `guardWarning`.

## The SSE stream

### `GET /api/sessions/:id/events` (legacy scope; workspace hosts use `…/:wid/sessions/:id/events`)

Streams `text/event-stream` frames. Each frame is a `data:` line holding one
`WebEnvelope`:

```ts
type WebEnvelope =
  | { kind: 'snapshot', events: SessionEvent[] }     // full log replay on connect
  | { kind: 'session',  event: SessionEvent }         // one live durable event
  | { kind: 'approval', approvalId: string, call: ToolCall, expiresAt?: number,
      interactive?: boolean, childSessionId?: string, definitionName?: string }
  | { kind: 'approval-settled', approvalId: string }
```

- After the initial snapshot, live events are relayed until the client
  disconnects; a 25 s heartbeat keeps proxies from dropping idle connections.
- Listeners are disposed on `close`, so a dropped browser tab never leaks
  registrations.
- The browser client (`web/lib/api.ts`) uses `EventSource` and reconnects on its
  own; the UI derives the connection state (`connecting` / `open` / `reconnecting`).
- Thinking-capable models stream `assistant/chunk` frames marked
  `"thinking": true`; the client renders them in a collapsible thinking panel
  and they never enter model history.
- An `approval` frame carries `expiresAt` from the policy's own timer, so the
  question shows the window it must be decided inside instead of a card that
  silently disappears. A question rebuilt from a log snapshot has no deadline
  and shows none. `definitionName` accompanies `childSessionId` so a relayed
  question names the agent that asked, not just its id.

## The perimeter: loopback, and optional control-plane auth

With `controlPlaneAuth` off, these routes carry no login. What stands between
them and the outside is the bind address, the `Host` allowlist, and the
cross-site write guard below. Anyone who can reach the port can send a message
that executes tools, so the port is the boundary: keep it on loopback.

With `controlPlaneAuth` on (`--auth`), privileged REST and SSE answer `401`
until a browser redeems the single-use pairing code, or a CLI presents a scoped
bearer. Cookie mutations also need the CSRF header and the canonical Origin.
That still does not protect against same-user malware or same-origin XSS, and
it is not an authenticated TLS profile.

Pairing is per browser. `GET /api/auth/state` reports whether *this* browser's
session is live and, when it is, returns its CSRF token so a reloaded page can
mutate again. A refused session (expired, revoked, or lost to a host restart —
sessions are in memory) returns the page to the pairing gate, and the refusal
clears the dead cookie so the browser can pair again.

The startup line prints one code that expires in five minutes. For another
code — a second browser, an expired code, or a lost session — run
`npm run pair` (add `-- --data-dir <dir>` when the host uses one). It reads
`<data-dir>/auth/operator.json`, which the running host publishes with its URL
and a random key and removes on shutdown, and asks the host to mint a fresh
code. Anyone who can read that file is the host's OS user, which is the trust
boundary above; agent file tools cannot read the data home.

A non-loopback `host` is **refused before anything is constructed**. This build
has no authenticated TLS profile, so `unsafeNetworkBind` does not open a
network bind. To reach the app from another machine, keep the server on
loopback and put an authenticated reverse proxy in front (add the proxy's name
to `allowedHosts`); terminals stay `403` on any non-loopback bind either way.

## The `Host` allowlist

Every request — API and static page alike — is refused with `403` unless its
`Host` header names something this server answers to: the loopback literals,
its own bind address, and anything in `allowedHosts`.

This is a DNS-rebinding defence. A browser will send requests to any name that
resolves to `127.0.0.1` and treat the response as same-origin, so binding to
loopback never kept a visited page out; refusing unknown `Host` values does.
The page is covered as well as the API, because the page is what would carry
an attacker's script.

The hole predates the terminal and spans the whole host — a cross-site mode
selection followed by a message could reach the `Bash` tool — but a terminal
turns it into a single silent step with no approval prompt, which is why the
guard landed with this feature rather than after it.

Set `allowedHosts` when the host legitimately answers to a LAN name or sits
behind a reverse proxy; `127.0.0.1`, `::1` and `localhost` need no entry.

## The cross-site write guard

The `Host` allowlist stops a rebound name, but not an ordinary cross-site
write: a `text/plain` POST is a *simple request*, so it is never preflighted,
and a page the user merely visited does not need to read the response to change
state here. So every method other than `GET`/`HEAD` is refused with `403` when
it carries an `Origin` whose `host:port` is not this server's (an opaque
`null` origin included).

A request with **no** `Origin` is left alone: that is curl, the tests, and any
non-browser client, none of which a foreign page can impersonate.

## Workbench terminals

An interactive, PTY-backed shell — full colour, resize, `Ctrl+C`, and curses
programs. The workbench shows it as a closable **Terminal** tab beside Files
and Git. The chat column has a second one in its footer, which takes no space
until `Ctrl+\`` opens it and the same shortcut (or the footer's close button)
hides it again. It is **not** an agent capability, and the
boundaries matter more than the feature:

- **Separate from the agent loop.** `src/web/terminals.ts` touches no
  `agentScope`, no `session/event`, no approval bridge and no tool registry. It
  is constructed in `createWebServer()` and is not exported from
  `src/index.ts`. The agent keeps its captured-output `Bash` tool and its `ask`
  gate; the two never share a shell.
- **No approval, by design.** The user types these commands. A per-command
  question would be theatre, so there is none. What guards the surface instead
  is the bind address.
- **Loopback only.** Every terminal route answers `403` when the host is not
  bound to `127.0.0.1`/`::1`: a network-reachable terminal is remote code
  execution for anyone who can open the page. Chat is unaffected by that gate.
  `terminals: { enabled: false }` removes the family entirely (`404`).
- **Ephemeral.** Terminal traffic never enters the session log — one `cat` of a
  large file would break snapshot replay. Scrollback lives in a 256 KB
  in-memory ring per terminal: a page reload replays it and reattaches, a host
  restart does not.
- **Per project.** A terminal records the project it was opened for and starts
  in that project's folder (the host's `--root` when no project is open). The
  panel shows only the open project's shells — another folder's shells get no
  tab, keep running out of sight, and the sidebar marks their folder with a
  terminal icon. The shell can still `cd` afterwards — the binding says where
  it belongs.
- **Surface state follows the folder.** Conversations in the same folder share
  one terminal state; conversations in different folders never touch each
  other's. Whether the chat footer is open (Ctrl+`) and whether the workbench
  strip carries the Terminal tab live per project under
  `dnt-harness.terminal.projects.v1`, keyed `<workspaceId>:<projectId>` (empty
  project id without a folder). The selected shell tab is remembered per
  project for the page's lifetime, so going to another folder and back lands
  on the same tab. The last shell of one folder exiting closes only that
  folder's footer. On upgrade, the old global `terminalOpen` flag and a
  conversation's stored Terminal tab seed projects until any project record
  exists.
- **Unbounded in count, bounded in bytes.** A workspace may open as many
  terminals as it wants; every live one is listed and attachable from its
  project's panel. Output is coalesced into 16 ms
  frames and a flush past 1 MB is dropped with an
  `[output truncated: too fast]` marker; a terminal idle for 30 minutes is
  reaped. `server.close()` kills every PTY, so none outlives the host.
- **Opening the view opens a shell.** The panel creates one terminal by itself,
  once per project per page load, rather than presenting a picker — landing in
  a chooser is not landing in a terminal. The auto-open waits until the
  conversation's project binding is final (`bindingReady`), so a shell never
  opens in the host's default folder just because the session list was still
  loading. The per-project allowance is spent on the first empty mount and is
  not refunded: switching sessions between folders remounts the panel but
  never stacks another shell — a new one is always a manual '+' or Ctrl+`.
  Closing the last terminal is a decision and is never undone automatically.
- **Default shell** is a browser-local preference (`terminalShell` in
  `dnt-harness.workbench.v1`), set from the Terminal view's shell menu. Unset, it
  defers to the host's own order: the platform's login shell first (zsh on
  macOS), then Bash, then PowerShell when Bash is absent on Windows. A
  remembered shell the host no longer offers falls back to that order instead
  of failing every open.
- **Shells** come from the shared resolver (`capabilities/shell/detect.ts`) and
  the client renders only what the host reports — zsh and Bash on macOS, Bash
  elsewhere (labelled Git Bash on Windows), and on Windows
  PowerShell and cmd. On Windows the PTY is created with `useConptyDll`: the
  default kill path forks a console-list helper that dies with
  `AttachConsole failed` once the shell has exited, and both paths were
  measured to reap a backgrounded grandchild.
- **cwd** is the conversation's project folder, or the host's `--root`
  otherwise. As with `Bash`, a shell is not path-confined: the user can `cd`
  anywhere the OS user can.

Frames are a separate wire type from `WebEnvelope`, so terminal traffic cannot
travel the session stream by accident. `data` and `scrollback` are base64
because PTY output is a byte stream:

```ts
type TerminalEnvelope =
  | { kind: 'snapshot', terminals: (TerminalInfo & { scrollback: string })[] }
  | { kind: 'created',  terminal: TerminalInfo }
  | { kind: 'data',     terminalId: string, data: string }
  | { kind: 'exit',     terminalId: string, exitCode: number, reason: 'exit' | 'killed' | 'idle' }
```

One stream carries every terminal in a workspace: browsers cap HTTP/1.1 at
about six connections per origin and the chat stream already holds one.
Keystrokes POST to `/input` batched per 16 ms frame rather than per character.

`node-pty` is imported lazily. Without it the routes answer `501` with the
install hint and the rest of the product is untouched; see the README for the
one-time npm install-script approval.

## The approval bridge

Approval questions must reach the *right* human. `attachApproval`'s `askUser`
reads the **ambient agent scope** (`agentScope`, an `AsyncLocalStorage`) that
`Agent.run()` populates while a turn is in flight:

```ts
askUser: (call, lifecycle) => new Promise<boolean>((resolve) => {
  const scope = agentScope.getStore()
  if (scope === undefined) { resolve(false); return }   // fail closed
  pending.set(lifecycle.approvalId, { sessionId: scope.sessionId, workspaceId, call, resolve })
  kernel.ctx.emit('web/approval', { sessionId: scope.sessionId, parentSessionId, approvalId: lifecycle.approvalId, call })
})
```

Each session's SSE stream filters `web/approval` by its own id **or** as the
parent of a child that is waiting, so **concurrent sessions share one policy
listener without cross-talk** and a child ask is answerable on the root
conversation. The selected mode's permission defaults are the sole policy
layer. `--yolo` changes asks to allows but preserves explicit denies; interactive
MCP still asks.

## Static serving

`GET` requests outside `/api/` are served from `staticDir` (default: the repo's
`web-dist/`). Unknown non-API paths fall back to `index.html` so client-side
state stands up; if the client is not built, a `404` suggests
`npm run build:web`. Path traversal outside `staticDir` is rejected.
`index.html`, the shell fallback, and `sw.js` are sent with `cache-control: no-cache`.

The build emits precompressed `.br` (brotli, max quality) and `.gz` twins for
every compressible asset ≥1 KB (`web/pwa/pwa-plugin.ts`); the server streams
those bytes as-is when the request's `Accept-Encoding` allows — no per-request
compression on the hot path — and answers identity bytes otherwise. Hashed
`/assets/*` paths carry `cache-control: public, max-age=31536000, immutable`.

### Installable client (PWA)

The built client is an installable PWA: `web/public/manifest.webmanifest` plus
icons in `web/public/icons/`. `web/pwa/pwa-plugin.ts` emits `web-dist/sw.js` at
build time from `web/pwa/service-worker.js`, stamped with a content hash and the
shell file list, so each rebuild replaces the worker and drops old caches. The
worker never handles `/api/` (REST and SSE stay live); navigations are
network-first with the cached shell as offline fallback; `/assets/` and
`/icons/` are cache-first. Registration runs only in production builds
(`web/pwa/register-service-worker.ts`). Install from the browser address bar
on `http://127.0.0.1:<port>` — localhost counts as a secure context; any other
host needs HTTPS. Chrome also hides the install icon until the worker is
controlling the page, so a failed install (previously `cache.addAll` aborting
on a proxy `Vary: *` response) looks the same as “not installable”. The worker
precaches each shell file on its own and still activates when one cannot be
cached.

## Shutdown

`server.close()` forces every connection down first (SSE connections never drain
on their own — a browser holds its `EventSource` open indefinitely), then closes
the listener and stops the kernel. The web bin maps the first `SIGINT` to a
graceful close and a second to an immediate exit.

## The React client (`web/`)

| Path | Purpose |
|---|---|
| `main.tsx` | entry, bundled mono font, providers, and the three production CSS imports |
| `App.tsx` | routing, server-backed state, send/stop/approval logic, and layout composition |
| `components/layout` | `Sidebar`, `WorkspacePopover`, `ChatHeader` (with the folder `ScopeControl`), `ContextSheet`, `ContextPanel` |
| `components/session` | project-grouped and time-bucketed conversation list |
| `components/chat` | `Transcript`, message/tool/delegation rows, thinking, work status, approvals |
| `components/composer` | `Composer` with attach/mode/thinking/permission chips, `ModelMenu` beside Send, `@`/`/` completion popover, attachment tray, folder picker |
| `components/workbench` | Files browser/viewer, Git (read-only status and diff), Trajectory (`projectTrajectory`, step slots), Subagents, and the lazily-loaded xterm `TerminalPanel` |
| `components/settings` | Settings dialog and provider editor; one module per workspace panel (Projects, Skills, Memory, Agents, MCP, Hooks, Secrets) built on the shared `settings-kit` |
| `components/ui` | Tailwind/CVA primitives with Radix interaction mechanics |
| `components/common` | icons, copy, confirmation, error, spinner, and toast surfaces |
| `hooks/` | SSE subscription, theme, media queries, transcript follow, focus restore, preferences |
| `lib/api.ts` | REST calls plus `EventSource` subscription |
| `lib/types.ts` | client mirror of existing wire shapes |
| `lib/project.ts` | durable `projectItems()` and turn-state derivation |
| `lib/turn-changes.ts` | per-turn `Write`/`Edit` outcomes projected from the log (the TurnChangesCard's data) |
| `lib/turn-git.ts` | overlay of the project's read-only git status onto one turn's files |
| `styles/app.css` | light/dark tokens, Tailwind theme mapping, base rules, management-panel hooks |
| `styles/markdown.css` | Markdown and highlight.js selectors |
| `styles/motion.css` | keyframes, scrollbar styling, and reduced-motion behavior |

`projectItems(events)` remains the transcript contract and is computed once per
event-array revision. `turnChanges(events)` is a companion projection for the
per-turn change card: it attributes each `Write`/`Edit` call to the turn open
at its position in the replay (tool traffic carries only a `stepId`), counts
success only when a result recorded it, and keeps failed, refused, and
recovered outcomes visible as `uncertain` rather than silent. The collapsed
card reads the log alone (line counts from the recorded arguments, exact to
the turn); expanding it loads the project's read-only git status once — those
+X −Y numbers are the files' *current* whole-worktree diff, shared across
turns, and the card says so instead of implying per-turn attribution. Bash
effects and child writes are never claimed: the log does not record what a
command touched, and a child's mutations live in the child's own log.
`projectTrajectory(events)` is a separate pure projection of
the same log into turns, model requests and tool calls; it fetches nothing and never
invents a timestamp or an outcome the log did not record. Its Duration view is a
sequence, not a clock: each step (a turn's input, a model request, the batch of tool
calls that request made) gets one equal slot in order, because wall time is mostly
idle gaps between turns and would crush every step into a sliver. Parallel calls
share their batch's slot. Selecting a slot shows what the log recorded for it; a
tool call in that detail expands to its exact arguments and output, the same row
the chat renders.

Clicking a model step opens the **request inspector** (`StepInspector`) in place of
the timeline: what one request carried, what answered, and how it physically went.
The projection additionally reads the observability events the transcript ignores —
`context/manifest` (per request, not folded per turn), `model/attempt` (every physical
attempt: provider, model, queue/progress timing, finish reason, retries, uncertain
settlement), `step/abandoned` (a mid-stream failure whose text never joined history,
kept on the trace of the request that finally answered), and `turn/error` (the turn's
durable failure classification). The inspector has three tabs: **Summary** (window,
per-source breakdown, attempts); **Request** (the full manifest plus every non-history
context block's raw text, fetched by content hash through the existing body route —
the same on-demand fetch the chat context marker uses); **Response** (the answer,
the streamed thinking the transcript never renders, tool calls as the chat's own
ToolCard rows, and the turn error if the turn failed). A model row warns in place
when its request was retried or settled uncertain. Legacy logs that never stamped
step ids still render: traces fall back positionally, and a request the log recorded
nothing about says so instead of showing an empty pane. Raw message arrays and tool
schemas as the provider received them are NOT reconstructible byte-for-byte; the log
keeps tool names and schema counts only, so the inspector presents the log's own
facts and no more.

The layout follows a ChatGPT-style shell: a resizable 280px-default sidebar
(232–420px) docked at 768px and above (a modal drawer below), one centered chat
column whose transcript scroller follows the tail only while the reader is at the
bottom, a composer section in normal flow below it, and a Workbench whose views
are Files, Git, Context, Trajectory, Subagents and Terminal. Files is the anchor tab; the
rest are opened on demand from the nav's `+` picker and closed again from their
tab, so the strip keeps room for opened file tabs. A stored strip that still names
the retired Artifacts view drops it on load. Files, Git and Trajectory are read-only
projections; Git asks the host for `git status` and one file's diff and never stages, commits, or discards; Context is read-only apart from its confirmed Compact. Subagents only
follows the open conversation's children — delegating is the model's job through
its `Agent` tool, and roles live in Settings → Agents. It groups them into
**Running** and **Ended** (newest first); a row is titled by the first line of the
child's brief from the root's log (its role when the log has none), previews the
first line of its report or error, names its role and `provider:model`, and opens
the child's own conversation, which is its full history. A running child can be
stopped from its row and flags one parked on an approval. An `uncertain` child
stays with the running ones as **Reconciling** with a **Retry settlement** button
that POSTs the workspace-scoped, parent-owned reconcile route — the same canonical
settlement the model's `Agent` reconcile action runs; the chat delegation card
projects durable events and never shows `uncertain`. Terminal
is the deliberate interactive exception documented above. The Workbench docks at 1280px and becomes a modal sheet below that. Sidebar/workbench collapse and dock
widths are browser-local preferences under `dnt-harness.workbench.v1`; the opened
Workbench views and the selected one are remembered **per conversation** under
`dnt-harness.workbench.tabs.v1`, keyed `<workspaceId>:<sessionId>` (or `draft`
before the first message) — a subagent conversation shares its root's record,
so a child and its parent read as one workbench. The Terminal tab is the
exception: its presence follows the project (see Terminal above), so every
conversation in a folder shows it or none does. One conversation's tabs never
leak into another; conversations without a record start from the tab fields of
the old global key until they gain one (the upgrade seed fades as records are
written); appearance (System/Light/Dark) is stored under
`dnt-harness.theme`; unsent composer drafts are kept per workspace+session under
`dnt-harness.drafts.v1` (text only — never `sending` or an error, which describe a
request that no longer exists). None of these are server settings. See
[design guidelines](design-guidelines.md) and [design system](design-system.md).

Context manifest loading is lazy and uses the existing endpoint only while the
sheet is open, Context is selected, a valid conversation exists, and the turn is
settled. Trajectory causes no request while the timeline shows; only opening a
step's inspector fetches, on demand and per hash, the raw context bodies that
step's manifest references (never automatically, never speculatively). Reconnect
presentation remains separate from durable running truth: drafts stay editable,
Stop remains available, and the client does not automatically resend or replay.

Settings remains a client for the existing provider/workspace APIs. Desktop uses
grouped tabs and narrow mobile uses a section selector; Providers, Projects,
Skills, Memory, Agents, MCP, Hooks, and Secrets remain reachable. Dirty provider
confirmation, blank-key omission, destructive confirmations, whole-document Hooks
validation/save, and explicit Skills/Memory conflict choices are retained.

Required client verification runs at 320, 375, 768, 1024, 1440, and 1920px in both
themes:

```sh
npm test
npm run typecheck
npm run build:web
npm run test:browser
```

Browser suites (`tests/browser/chat-shell.e2e.ts`, `tests/browser/chat-workflows.e2e.ts`)
use intercepted fixtures and never mutate real settings. Screenshot evidence is
written to `artifacts/product-ui/chat/`; it is not an approved visual baseline.

## Reading further

- Full API behavior tests: `tests/web/server.spec.ts` (meta, model/folder
  switching, session lifecycle, rename and delete, stopping a running turn,
  thinking-chunk streaming, snapshot+live streaming, the approval round-trip,
  denial surfacing, duplicate-answer 404s, static fallback).
- Per-conversation model tests: `tests/web/server-session-model.spec.ts`
  (creation snapshot, session isolation, legacy fallback, restart replay,
  mid-turn switch, durability fencing); durable vocabulary:
  `tests/harness/session-model.spec.ts`.


## Listing and agent catalog notes

Workspace session listings may include optional `createdAt`/`updatedAt` from existing event-backed summaries. Empty conversations omit these fields; clients must not invent dates. No existing request or approval wire format changed.

Agent catalog: `GET /api/workspaces/:id/agents` returns bundled, user (`~/.claude/agents`), workspace and (with `?projectId=`) project definitions; later layers override by name. Imported definitions can be selected, inspected, spawned and explicitly deleted. Bundled-role deletion remains prohibited. Management panels reset on workspace/root changes and invalidate stale async state feedback. New providers may omit API keys for keyless endpoints.
