# Hook `if`, `async` and `asyncRewake` — design

Date: 2026-10-12. Status: approved (Stop kills background hooks; caps as proposed). Parent spec: `2026-10-10-claude-plugins-design.md`.

## Goal

Run Claude Code command hooks that use `if`, `async` or `asyncRewake` with
the semantics Claude Code 2.1.293 gives them. Today `parseHooksSection`
(`src/harness/hooks/settings.ts`) drops every such hook with the diagnostic
"valid Claude plugin hook configuration but is not run by dnt-harness".

That drops 18 hooks of the official marketplace:

| Plugin | Event (matcher) | Fields | Purpose |
|---|---|---|---|
| security-guidance | PostToolUse (`Bash`) ×7 | `if` + `asyncRewake` | Background security review after `git commit/push`, `gt create/modify/submit` |
| security-guidance | Stop | `asyncRewake` | Background review at turn end |
| claude-security | PostToolUse, PostToolUseFailure (`Bash`) | `if` + `async` + `asyncRewake` | Runs on `py* *claude-security*scripts/*.py *` |
| claude-security | PostToolUse (`Bash`) ×2 | `if` | Runs on `git push *`, `gh pr create *` |
| code-modernization | UserPromptSubmit, Stop ×2, SessionStart, PostToolUseFailure, StopFailure | `asyncRewake` | Telemetry |

The format stays Claude's. The only dnt-harness addition is the existing
workspace layer; nothing here adds new hook fields.

## Claude semantics (2.1.293)

Read from the command hook schema (`Dp()`) in the shipped binary:

- `if`: "Permission rule syntax to filter when this hook runs (e.g.
  `Bash(git *)`). Only runs if the tool call matches the pattern. Avoids
  spawning hooks for non-matching commands." Also accepted on `prompt`,
  `mcp_tool` and `http` hooks, which dnt-harness does not run.
- `async`: "runs in background without blocking".
- `asyncRewake`: "runs in background and wakes the model on exit code 2
  (blocking error). Implies async."
- `rewakeMessage` (internal): prefix of the system reminder the model sees;
  the hook output is appended after it.
- `rewakeSummary` (internal): one line shown to the user. Default
  "Stop hook feedback".
- A rewake hook that exits 2 only because its interpreter cannot open its
  script is a broken installation: Claude reports it once, drops identical
  repeats and does not wake the model.

## Decisions

1. `if` is evaluated only against a tool call: PreToolUse, PostToolUse and
   PostToolUseFailure. On any other event a hook with `if` never runs, and
   the loader reports that as a diagnostic.
2. `if` matching leans toward running. A filter that wrongly skips a
   security hook is worse than an extra hook process, so the matcher runs
   the hook whenever it cannot prove the call does not match. This is the
   opposite of `allowed-tools`, where an unprovable match must stay an ask.
3. `async` and `asyncRewake` hooks never affect the turn that fired them:
   no permission decision, no block, no `updatedInput`, no
   `additionalContext`.
4. Background hooks outlive the turn that fired them, but a user Stop of the
   conversation kills them, as do closing or deleting the session and host
   shutdown. A hook killed this way never rewakes.
5. A rewake is delivered as durable queued input to the **root**
   conversation. It never interrupts a running turn: it runs as the next
   turn, or wakes an idle conversation immediately.
6. Rewake content is lower-trust data, framed like `hookContextBlock`. Both
   `rewakeMessage` and the hook's output are plugin text, never authority.
7. Rewakes are bounded per conversation, and identical repeats are dropped,
   so a `Stop` + `asyncRewake` hook cannot loop the model.

## Design

### 1. Parsing (`src/harness/hooks/settings.ts`)

`HookCommand` and `ResolvedHook` gain optional fields:

```ts
readonly if?: string
readonly async?: true
readonly asyncRewake?: true
readonly rewakeMessage?: string
readonly rewakeSummary?: string
```

- Remove the "not run" rejection.
- Validation follows the existing style: `if` must be a non-empty string,
  `async`/`asyncRewake` must be booleans, `rewakeMessage`/`rewakeSummary`
  must be non-empty strings. A bad value is a problem, so strict app saves
  throw and loaded files get a diagnostic for that entry only.
- An `if` whose rule does not parse (`parseAllowRule` returns undefined, or
  the tool has no dnt-harness equivalent) is a diagnostic and the hook is
  skipped.
- An `if` on an event without a tool call is a diagnostic; the hook is kept
  in `all` (Settings shows it) and never selected.
- `asyncRewake: true` implies background execution even without `async`.
- `hookId` includes `if` when it is present. The seven security-guidance
  hooks share one command and differ only in `if`; each needs its own
  Settings toggle. Hooks without `if` keep their current id.
- Other Claude fields (`once`, `args`, `shell`, `statusMessage`) are out of
  scope and stay ignored, as today.

### 2. `if` matching (`src/harness/commands/allowed-tools.ts`)

Extract the per-rule match of `allowedByRules` into one function with an
explicit mode, so the two callers cannot drift:

```ts
type RuleMode = 'grant' | 'filter'
export function ruleMatchesCall(rule: AllowRule, call: ToolCallLike, mode: RuleMode, baseDir?: string): boolean
```

- `grant` is today's `allowed-tools` behavior, unchanged:
  - a command with `hasUncoveredShellSyntax` never matches;
  - a compound command matches only when every part matches.
- `filter` is used by `if`:
  - a compound command matches when **any** part matches. `cd repo && git
    commit -m x` must trigger the commit review.
  - with uncovered shell syntax (`$(…)`, backticks, `&`, redirects), the
    command also matches when the rule's literal prefix (the specifier up to
    its first `*` or `:*`) occurs anywhere in it. Example: `` echo `git
    commit -m x` `` matches `Bash(git commit:*)`.
  - file-tool rules use the same path globbing. A target that cannot be
    relativized safely (`..`, outside the project) matches.
- `if` is checked against the call **after** PreToolUse rewrites for Post
  events, and against the proposed call for PreToolUse. Both are the call
  the hook input describes.

`HookFire` gains `toolCall?: { name; args }`; the three tool events pass it.
`selectHooks(resolved, event, value, toolCall)` drops hooks whose `if` does
not match **before** de-duplicating by command. The security-guidance hooks
share one command, so de-duplicating first would keep only the first `if`.

### 3. Background execution (`src/web/background-hooks.ts`, new)

`HookHost.fire()` splits the selected hooks into two sets:

- **Foreground** (neither `async` nor `asyncRewake`): unchanged. They are
  awaited, audited, then interpreted.
- **Background**: handed to a `BackgroundHooks` registry and not awaited.
  `fire()` returns `{ verdict, ran, launched }`, and the verdict is built
  from foreground outcomes only.

`BackgroundHooks`:

- Owns one `AbortController` per launch, keyed by root conversation.
  - `killRoot(rootSessionId)` is called on a user Stop of the conversation
    (the stop route), on session close and on delete.
  - `killAll()` is called on host shutdown.
  - Turn signals are not linked: a turn that ends normally leaves its
    background hooks running.
- Runs the hook with `runHook` (same scrubbed env, output cap, timeout and
  process-tree kill as foreground hooks). The timeout is the hook's
  `timeout`, default 60 s.
- Caps concurrency at 8 per root conversation and 32 per host. A launch over
  either cap does not run. It is audited as `decision: 'skipped:cap'` so the
  user can see it.
- On completion, appends `hook/run` to the session that fired it, if that
  session is still open, then calls `durable()`. The record gains optional
  `background: true`, and `rewake: 'woke' | 'dropped' | 'capped' |
  'broken-install'` when that applies. Both fields are optional additions to
  an existing log-only event, so old logs still read.
- `ran`/`launched` counts and the registry size are exposed for tests.

### 4. Rewake delivery

On completion of an `asyncRewake` hook:

1. **Not a rewake** in any of these cases; the hook is only audited:
   - exit code ≠ 2;
   - the session is closed;
   - `syntaxError`.
2. **Broken install:** exit 2 with stderr matching an interpreter "cannot
   open" error (`can't open file`, `No such file or directory` naming the
   script) is reported once per hook id and output hash as a user-visible
   `hook/run` message. It never wakes the model.
3. **Dedupe:** the same hook id with the same output hash as an earlier
   rewake in this conversation is dropped (`rewake: 'dropped'`).
4. **Cap:** at most 4 rewakes per root conversation per 10 minutes. The
   overflow is audited (`rewake: 'capped'`) and does not wake.
5. **Deliver** to the root conversation:
   - Build the text:
     ```
     hookRewakeBlock(event, rewakeMessage ?? "Background hook feedback:", output)
     ```
     `output` is stderr, or stdout when stderr is empty, capped at 8 KB.
     The block uses the same lower-trust framing as `hookContextBlock`.
   - Append durable `input/queued` with new `origin: 'hook'`, `inputId`, and
     `summary` (= `rewakeSummary ?? "Stop hook feedback"`), then wait for
     `durable()`.
   - Call the same drain the subagent executor uses: `dispatchInbox(entry,
     deps, 'queue')`. That wakes an idle conversation, and leaves the input
     queued behind a running turn. It never steers.

Data model changes:

- `input/queued` gains `origin?: 'hook'` and `summary?: string`.
- `PendingInput` and `InboxItem` carry `origin`.
- `user/message.origin` adds `'hook'`. The agent copies the origin from the
  inbox item, as it does for `injected` → `context`.

Pre-step (`agent/pre-step` in `server.ts`):

- Claimed inputs with `origin: 'hook'` are **not** passed to
  UserPromptSubmit hooks and are never expanded as slash commands.
- When every claimed input is a hook rewake, UserPromptSubmit does not fire
  at all.

After a host restart, a still-pending hook input is ordinary pending input.
Like any pending input, it does not auto-run.

### 5. Web UI

- **Transcript:** a `user/message` with `origin: 'hook'` renders as a
  collapsed notice in the activity column. It shows the `summary` line and
  expands to the delivered text. It never renders as a user bubble.
  `web/lib/project.ts` gains a `hook-rewake` item, like
  `command-expansion`.
- **Activity:** `hook/run` rows with `background: true` are tagged
  "background", and rows with a `rewake` outcome show it.
- **Settings → Hooks:** each hook shows `if`, `async` and `rewake` badges.
  The "not run" diagnostics for these fields disappear.

## Files

| File | Change |
|---|---|
| `src/harness/hooks/settings.ts` | Parse and validate the fields; `hookId` with `if`; `selectHooks` filters `if` before de-duplicating |
| `src/harness/commands/allowed-tools.ts` | `ruleMatchesCall` with `grant`/`filter` modes; `allowedByRules` uses `grant` |
| `src/harness/hooks/runner.ts` | `hookRewakeBlock`, broken-install detection, audit fields |
| `src/web/background-hooks.ts` (new) | Registry: launch, caps, kill, completion audit, rewake hand-off |
| `src/web/claude-hooks.ts` | `HookFire.toolCall`; foreground/background split; `launched` |
| `src/web/server.ts` | Pass `toolCall` for the three tool events; rewake delivery to the root; skip UserPromptSubmit/expansion for `origin: 'hook'`; kill on close, delete and shutdown |
| `src/harness/session/events.ts`, `session/service.ts`, `agent/types.ts`, `agent/agent.ts` | `origin: 'hook'` and `summary` on queued input and user messages |
| `web/lib/project.ts`, transcript and activity components, `HooksPanel.tsx`, `web/lib/types.ts` | Rendering above |
| `docs/plugins.md`, `docs/claude-format.md` | Remove the limitation; document the semantics and caps |

## Tests

Real processes and real HTTP, as in the existing hook and plugin suites.
No mocked runners.

- **Parser:**
  - all fields accepted;
  - invalid types are diagnostics;
  - `if` on a non-tool event is a diagnostic;
  - an unparseable rule is a diagnostic;
  - seven hooks with one command and different `if` get seven ids.
- **Matcher:**
  - `grant` behavior unchanged (the existing `allowed-tools` tests still
    pass);
  - `filter` matches any compound part, substitution and redirect forms, and
    `git -C * commit *`;
  - a non-matching command does not match.
- **`if` end to end:**
  - a PostToolUse hook with `if: Bash(git commit:*)` runs for `cd x && git
    commit -m y` and not for `git status`;
  - a hook process is never spawned for a non-matching call (marker file
    absent).
- **`async`:**
  - the turn completes before a hook that sleeps 2 s;
  - its `hook/run` lands afterwards with `background: true`;
  - its JSON decision is ignored;
  - a user Stop and closing the session kill it, and a killed rewake hook
    never wakes;
  - the cap skips the ninth concurrent launch with `skipped:cap`.
- **`asyncRewake`:**
  - exit 2 on an idle conversation starts a new turn whose model request
    contains the framed text and whose transcript item carries the summary;
  - exit 2 during a running turn queues behind it and does not steer;
  - exit 0 and exit 1 do not wake;
  - an identical repeat is dropped;
  - the fifth rewake in the window is capped;
  - a broken install is reported once and does not wake;
  - a rewake input skips UserPromptSubmit and slash expansion;
  - a deleted session is never woken.
- **Stop loop:** a `Stop` hook with `asyncRewake` that always exits 2 with
  the same output produces exactly one rewake.
- **Marketplace:** all three official plugins load with no "not run"
  diagnostics.

## Phases

1. `if` and the matcher modes (parser, `selectHooks`, tool events).
2. `async`: the background registry, audit and lifecycle.
3. `asyncRewake`: delivery, the `origin: 'hook'` data model, UI and caps.

Each phase lands with its tests, `pnpm run typecheck`, the affected suites,
then `pnpm test`; the UI phase adds `pnpm run build:web`.

## Risks

- **Cost:** every rewake is an unprompted model request. This is bounded
  by the cap and the dedupe, and visible through the summary row.
- **Prompt injection:** rewake text is plugin-controlled. It enters only as
  framed lower-trust data, under the session's mode, policy and approvals,
  with no added permissions.
- **Over-matching `if`:** extra hook runs are accepted by design (decision 2).
  The only cost is a process spawn.
