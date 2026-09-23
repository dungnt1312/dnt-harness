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

## The client is stateless by design

The browser client holds **no model state of its own**. The transcript is
projected from the durable session events streamed over SSE — a fresh connection
first receives a **snapshot** of the whole log, then live `session/event`
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
- Expanded tool rows show all arguments and output; transcript identities are explicit (right-aligned user bubbles, plain assistant prose).

### Production task workflows

- **New conversation** and Ctrl/Cmd+N clear the canvas without creating a session. The composer's scope chip picks an existing project, a newly chosen folder, or **Chat only**; the session is created by the first sent message, and a failed first send keeps the draft.
- The sidebar footer owns workspace selection; the sidebar also groups project history and search. History filters only affect navigation, never a session's immutable execution project.
- The Context sheet starts closed at every viewport size. Context manifests load only while it is open. The main pane shows durable task lifecycle and separately explains event-stream connection loss. Queued/being-submitted inputs show preparing; open turns show running or waiting approval; terminal reasons remain visible. Partial assistant chunks stop appearing live at turn end.
- Composer is a contenteditable with inline chips: `@` lists files from the conversation's project (bounded search that never follows symlinks or walks hidden/`node_modules` trees) and inserts a mention chip rendered where the caret was; `/` at the start inserts a skill invocation phrase as plain text; `+` attaches a project file (reference chip) or an uploaded file (stored blob chip), and pasted/dropped images become attachment chips. Neither completion nor attachment grants a permission, reads a file, or pins a skill by itself. Both menus stay shut without a source, are driven from the contenteditable (a combobox with `aria-activedescendant`), and Escape closes them until the query changes. Removing a chip removes exactly that segment; ArrowUp on an empty composer brings back the newest own message; unsent drafts (text plus chips) survive a reload.
- Composer context shows the fixed project path or an explicit no-project warning with a new-conversation CTA. “Chat-only” describes absence of a project, not an automatic switch to Chat mode or a promise to disable every tool. Model and thinking controls belong to the conversation and apply at its next request (the no-conversation pickers write the global default for future sessions); the selected mode governs permissions at the next request/tool gate. Mode and server restrictions still apply.
- The composer footer is grouped by what each control decides, not by control type: attach and mode sit on the left, while the model and its thinking level — whose available levels come from that model — sit together on the right next to Send. The footer answers to the composer's own width (a container query, because the column is far narrower than the viewport with the sidebar open): one row when controls fit, otherwise two deliberate rows rather than a ragged wrap. When the row is tight the model name truncates and nothing else does, and it never truncates to nothing.
- Approval review exposes tool name, target, full escaped JSON arguments, call ID, conversation project and the window the request cancels itself in. **Allow once** and **Deny** answer only that pending request. It does not widen host `blockedTools`, mode exposure, or project root. A file path outside the granted folders shows `Outside granted folders: …`; on a root conversation the card may also offer **Allow `<folder>` for this session**, naming exactly the folder it grants.
- The composer's folder chip (`+N`) lists the extra folders the conversation's file tools can use — from project settings (Settings → Projects → **Extra folders**, read-only or read & write, other projects or any folder) and the conversation's own, which it can add or remove. Shell commands are not confined by these folders. Interactive MCP tools keep asking. Child-agent questions relay onto the parent conversation, labelled with the child's agent name and id. Buttons lock while submitting; failed submissions remain visible. Durable decisions remain in transcript history, including expiry/invalidation.
- The selected mode is the workspace's permission truth. Its `permissionDefaults` decide each tool; `--yolo` is stated on the trigger and maps asks to allows, but never lifts an explicit deny.
- Failed, cancelled, limited and interrupted work offers inspection-first recovery guidance. Unknown recovered tool results are explicitly called out. There is no automatic retry or replay control: inspect actual effects, then submit new instructions limited to remaining work.
- The Providers pane states each fact once. The provider name is its editable title (rename in place) with enablement as a state pill plus the opposite verb, and delete lives on that title row; the rail carries the name, the `default` marker and the enabled dot. A model row is one pill — id, `Vision` when it accepts images, its context window — with the provider-default radio and the global-default, edit and remove actions beside it. Per-model overrides open in **Edit model settings**, committed or abandoned as one decision: id (renaming carries its overrides), context window, input types — text is shown locked because every model takes it, image is a checkbox whose state is the effective one, with a link back to the catalog default once it is overridden — and thinking default. **Sync from /models** probes the endpoint and opens a selection: checked models are kept, unchecking one removes it, models the endpoint does not offer are left alone, and nothing is stored until Save.
- Settings distinguish global provider storage plus the global default model from workspace services. **Modes** sits after Projects in the Workspace group: its structured editor loads a workspace file into a form (name, instructions, context sources, tool exposure, per-key permissions), saves existing files with `expectedHash`, and offers Reload or an overwrite that first reloads the fresh hash after a conflict. Its catalog puts bundled read-only modes first (Duplicate only), then workspace modes (Edit/Delete); every row can be disabled, which hides the mode from the composer picker until re-enabled. It plainly lists each `permissionDefaults` key including `*` and MCP patterns. A saved mode change applies only when the mode is next selected; deleting the selected file likewise leaves the workspace's active cached snapshot active until another mode is selected. Agent definitions are workspace-scoped; child listings are current-session-scoped. Saving configuration is not evidence of connectivity; provider connection checks use saved configuration rather than unsaved drafts.
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
| `--auth` | require control-plane pairing; the startup line then prints a single-use code (`MINI_DSH_AUTH=1` does the same, `--no-auth` overrides it) | off |

The server always boots even with no provider configured, so the Settings panel
can add one. `DEEPSEEK_API_KEY` seeds a `deepseek` entry on first boot; a blank
or absent key prints a hint pointing at the Settings UI. The scripted mock
provider is gone — without a usable provider, chat requests answer `400` until
one is configured.

## Provider configuration

Providers are stored as plain JSON in `~/.mini-dsh/providers.json`
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
| `…/:wid/sessions`, `…/:wid/sessions/:id` (+ `/events` SSE, `/messages`, `/stop`) | session lifecycle, streaming, queued messages, stop. `/messages` answers 409 for a child agent session: children are executor-managed and cannot be resumed directly |
| `GET/PUT …/:wid/sessions/:id/model` | the conversation's own model controls (model, provider, thinking level) — see the per-conversation model section |
| `GET/PUT …/:wid/sessions/:id/grants` | the conversation's extra file-tool folders: `GET` returns `{ revision, roots, effective }` (effective = project + session grants merged); `PUT { expectedRevision, roots: [{ path, access }] }` replaces the list — browser principal only, `409` on a stale revision or a conversation without a project, `400` for a folder the grant validator refuses (see `docs/capabilities.md`) |
| `…/:wid/sessions/:id/manifest`, `…/compact` | per-request context manifest; manual compaction into an immutable checkpoint |
| `GET/PUT /api/model-defaults` | the **global** default provider/model/thinking level, shared by every workspace: the pair new sessions snapshot at creation, the draft pickers' target, and the live fallback for legacy conversations without a snapshot |
| `PUT …/:wid/model`, `PUT …/:wid/thinking` | compatibility proxies: they verify workspace ownership, then mutate the **global** default above; new clients use `/api/model-defaults` |
| `PUT …/:wid/mode`, `GET …/:wid/meta` | workspace-local mode control. The selected mode is the sole permission source. The `GET …/mode` catalog lists **enabled modes only** (a disabled mode refused for selection answers `400`); `GET …/meta` returns the selected mode's `permissionDefaults`, `mode`, and `yolo` when enabled; it does not return a policy or effective-policy overlay. |
| `GET …/:wid/modes`, `GET/PUT/DELETE …/:wid/modes/:mid`, `POST …/:wid/modes/:mid/duplicate`, `PUT …/:wid/modes/:mid/enabled` | mode **authoring**, separate from the selection control above. The catalog carries each mode's `enabled` flag, `toolExposure`, and `permissionDefaults`; the single-mode read returns raw Markdown plus a hash, and `PUT` takes `{ content, expectedHash? }` (required when replacing an existing file). Bundled modes are read-only (`400`), a stale or missing update hash is `409`, and invalid content is rejected before anything is written. `PUT …/enabled` takes `{ enabled: boolean }`: it shows or hides a mode in this workspace's picker — bundled modes may be hidden too, disabling the currently selected mode is `409` (select another first), the disabled set persists beside the mode files, and saving a mode always re-enables it. Editing a selected mode applies only when it is **re-selected**: the live selection retains its cached snapshot. Deleting that selected file also leaves its cached snapshot active, but its deleted id cannot be selected again; select another mode instead. |
| `…/:wid/projects` (+ `/projects/:pid`) | project binding: working folder, ownership, overlap rejection. `PATCH` also takes `additionalDirectories: [{ kind: "path", path, access } \| { kind: "project", projectId, access }]` (browser principal only, every folder validated); retargeting is `409` while any turn — this project's or another's through a grant — holds a write lease inside it |
| `GET …/:wid/projects/:pid/(files\|file\|search)` | read-only project browsing: one directory listing, one file body, and a bounded file-name search for composer mentions |
| `…/:wid/terminals` (+ `/events` SSE, `/:tid` DELETE, `/:tid/(input\|resize)`) | interactive Workbench terminals: PTY lifecycle, one multiplexed output stream per workspace — see the terminal section |
| `POST …/:wid/attachments`, `GET …/:wid/attachments/:id` | composer attachments: upload (content-addressed by sha256, verified media type) and serve (immutable, workspace-scoped) |
| `…/:wid/agents/:name` (GET resolve / DELETE), `POST …/:wid/agents/:name` | agent definitions; POST spawns a bounded child from `task: { prompt, requiredResult }` or the four-field `task: { objective, constraints, references, requiredResult }`, optionally `inherit: "brief"`, `model` (`provider:model`) and `grantTools`. 202 with the handle (+ `inheritedChars`, `note`); an empty brief, a bad `inherit`, or a role that refuses inheritance is 400; capacity (per conversation or host) is 429 |
| `POST …/:wid/agents/:name/import` | save a definition: `dialect: "claude"` / `"codex"` import with provenance, or `"mini-dsh"` to save a native document verbatim (keeps `inheritable`) |
| `GET …/:wid/agents/children?root=…`, `GET/DELETE …/:wid/children/:childId` (+ `/cancel`), `POST …/:wid/sessions/:parentSessionId/children/:childSessionId/reconcile` | child list / wait-result / cancel / settlement; statuses may include `uncertain`, which is stable across restarts until settled — repair runs through the Agent tool, the Workbench's Retry settlement, or the reconcile route (below); the legacy `POST /api/sessions/...` reconcile address is retained |
| `…/:wid/mcp` (+ `/:server` GET/POST/DELETE, `/:server/(enable\|disable\|reconnect)`, `/mcp/import`) | MCP server lifecycle, stored config for editing, deletion, and imports with provenance |
| `…/:wid/hooks`, `…/:wid/secrets(/:key)` | hook bindings; encrypted secret management (masked responses) |

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
stream events and closes the turn durably with `turn/end: { reason: "stopped" }`
— a result, not a failure.

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

An interactive, PTY-backed shell in the Workbench — full colour, resize,
`Ctrl+C`, and curses programs. It is **not** an agent capability, and the
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
  panel shows only the open project's shells and opens one for a project that
  has none; switching projects never surfaces another project's shell. The
  shell can still `cd` afterwards — the binding says where it belongs.
- **Bounded.** Four terminals per workspace, whichever project they belong to;
  output is coalesced into 16 ms
  frames and a flush past 1 MB is dropped with an
  `[output truncated: too fast]` marker; a terminal idle for 30 minutes is
  reaped. `server.close()` kills every PTY, so none outlives the host.
- **Opening the view opens a shell.** The panel creates one terminal by itself,
  once per mount, rather than presenting a picker — landing in a chooser is not
  landing in a terminal. Closing the last terminal is a decision and is never
  undone automatically.
- **Default shell** is a browser-local preference (`terminalShell` in
  `mini-dsh.workbench.v1`), set from the Terminal view's shell menu. Unset, it
  defers to the host's own order: Git Bash first, PowerShell when Git Bash is
  absent on Windows. A remembered shell the host no longer offers falls back to
  that order instead of failing every open.
- **Shells** come from the shared resolver (`capabilities/shell/detect.ts`) and
  the client renders only what the host reports — Git Bash, and on Windows
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
host needs HTTPS.

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
| `components/artifacts` | pure existing-event artifact projection and read-only Artifacts panel |
| `components/workbench` | Files browser/viewer, Agent runs, and the lazily-loaded xterm `TerminalPanel` |
| `components/settings` | Settings dialog and provider editor; one module per workspace panel (Projects, Skills, Memory, Agents, MCP, Hooks, Secrets) built on the shared `settings-kit` |
| `components/ui` | Tailwind/CVA primitives with Radix interaction mechanics |
| `components/common` | icons, copy, confirmation, error, spinner, and toast surfaces |
| `hooks/` | SSE subscription, theme, media queries, transcript follow, focus restore, preferences |
| `lib/api.ts` | REST calls plus `EventSource` subscription |
| `lib/types.ts` | client mirror of existing wire shapes |
| `lib/project.ts` | durable `projectItems()` and turn-state derivation |
| `styles/app.css` | light/dark tokens, Tailwind theme mapping, base rules, management-panel hooks |
| `styles/markdown.css` | Markdown and highlight.js selectors |
| `styles/motion.css` | keyframes, scrollbar styling, and reduced-motion behavior |

`projectItems(events)` remains the transcript contract and is computed once per
event-array revision. `projectArtifacts(events)` is a separate pure projection over
existing tool calls/results. It shows only exact path/resource references, command
records, and recorded tool output; it never fetches file details or claims file
existence, content, diffs, MIME type, repository ownership, or rerun capability.

The layout follows a ChatGPT-style shell: a resizable 280px-default sidebar
(232–420px) docked at 768px and above (a modal drawer below), one centered chat
column whose transcript scroller follows the tail only while the reader is at the
bottom, a composer section in normal flow below it, and a Workbench whose views
are Files, Context, Artifacts, Agents and Terminal. Files is the anchor tab; the
rest are opened on demand from the nav's `+` picker and closed again from their
tab, so the strip keeps room for opened file tabs. Files and Artifacts are
read-only projections; Context is read-only apart from its confirmed Compact,
Agents delegates and cancels child runs for the open conversation — including
the ones the model spawns for itself through the `Agent` tool, with each child's
`provider:model` on its card and a picker that overrides the role's own model.
Its primary field is a prose **Brief**; the structured objective, constraints,
references and required result stay in *Task packet details*. A child card (and
the chat delegation detail) shows the child's final report, a visible
truncation note when the report hit the host cap, the files it touched, or the
error naming its session log. In the Agents view an `uncertain` child renders
as a retained, non-terminal run with a `reconciling` marker and a
**Retry settlement** button that POSTs the workspace-scoped, parent-owned
reconcile route (it passes the open workspace's id) — the same canonical
settlement the model's `Agent` reconcile action runs; the chat
delegation card projects durable events and never shows `uncertain`.
It offers no inherited-context control — and Terminal
is the deliberate interactive exception documented above. The Workbench docks at 1280px and becomes a modal sheet below that. Sidebar/workbench collapse, dock widths, the opened
Workbench views and the selected one are browser-local preferences under `mini-dsh.workbench.v1`;
appearance (System/Light/Dark) is stored under
`mini-dsh.theme`; unsent composer drafts are kept per workspace+session under
`mini-dsh.drafts.v1` (text only — never `sending` or an error, which describe a
request that no longer exists). None of these are server settings. See
[design guidelines](design-guidelines.md) and [design system](design-system.md).

Context manifest loading is lazy and uses the existing endpoint only while the
sheet is open, Context is selected, a valid conversation exists, and the turn is
settled. Artifacts causes no request. Reconnect presentation remains separate from
durable running truth: drafts stay editable, Stop remains available, and the client
does not automatically resend or replay.

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

Agent catalog: `GET /api/workspaces/:id/agents` returns bundled and workspace definitions using the existing definition service. Imported definitions can be selected, inspected, spawned and explicitly deleted. Bundled-role deletion remains prohibited. Management panels reset on workspace/root changes and invalidate stale async state feedback. New providers may omit API keys for keyless endpoints.
