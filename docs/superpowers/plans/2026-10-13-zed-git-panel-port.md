# Zed Git Panel 1:1 Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only workbench Git panel with the selected Zed Git panel workflow: trust-aware system-git commands, staging, commit/amend/signoff/skip-hooks/uncommit, remote operations, askpass, OS trash, and Zed-equivalent UI feedback.

**Architecture:** A trust-aware Git command layer owns process creation, login-shell environment, status parsing and a per-repository queue. Focused operation and askpass modules sit behind POST/NDJSON routes; the React panel consumes those APIs through pure model helpers and focused list/commit/remote components. Existing inline diff and turn filtering remain intact.

**Tech Stack:** Node.js 24, TypeScript, `node:child_process`, `node:net`, HTTP NDJSON, React 19, Radix primitives, Tailwind, Vitest/jsdom, system Git.

**Spec:** `docs/superpowers/specs/2026-10-12-git-panel-write-actions-design.md`

## Global Constraints

- Port behaviour and visible copy from `zed-industries/zed@c66312b`; do not invent alternatives.
- Use the system Git CLI. Do not introduce libgit2 or a Git npm dependency.
- Every Git command always adds `-c core.fsmonitor=false -c log.showSignature=false --no-optional-locks --no-pager`.
- Untrusted projects additionally add `core.hooksPath=/dev/null`, `core.sshCommand=ssh`, `credential.helper=`, `protocol.ext.allow=never`, `diff.external=`, and `--no-ext-diff` for diff.
- Existing and new projects default to untrusted until `gitTrusted === true` is persisted.
- Git process environment comes from the project directory's login shell and is cached per directory.
- Do not add Git command timeouts; completion is process exit or explicit askpass cancellation.
- Preserve existing `pathFilter`, `focusPath`, inline diff, open-file hover behaviour, and the no-layout-cost hover action contract.
- Unsafe HTTP methods use the existing browser-session auth, origin and CSRF checks.
- Passwords and passphrases are never logged, persisted, included in error text, or returned after use.
- Markdown changes stay under `docs/`; implementation reports stay under `plans/`.
- Use pnpm. Run affected tests first, then `pnpm test`, `pnpm run typecheck`, and `pnpm run build:web`.

## Review Focus

1. A path named `-rf` or containing spaces/newlines must stay after `--` and must never become a Git option; Task 2 pins this with a real repository test.
2. A client disconnect or Cancel while Git waits in askpass must kill the Git process, close the socket, delete temporary scripts, and remove the prompt registry entry; Task 3 pins every cleanup.
3. Two browser Git mutations plus a terminal Git command must not corrupt the index; Task 2 pins panel serialization and verifies Git's `index.lock` error remains visible.
4. Existing project JSON without `gitTrusted` must load as untrusted without migration failure; Task 1 pins backward compatibility.
5. A partially staged file, a resolved conflict and an untracked file must produce the same section and checkbox decisions as Zed; Tasks 1 and 5 pin these model states.

---

## File Structure

### Server and shared state

- `src/harness/workspace/types.ts`: persist optional `gitTrusted`.
- `src/harness/workspace/service.ts`: `setProjectGitTrusted` mutation.
- `src/web/project-git.ts`: Git executable, login-shell env cache, trust-aware command builder, status/diff parsing.
- `src/web/project-git-ops.ts` (new): serial operation queue, local/remote operations, remote resolution, OS trash.
- `src/web/git-askpass.ts` (new): askpass sessions, prompt registry, socket/pipe lifecycle, GPG wrapper.
- `src/web/git-askpass-client.mjs` (new): small executable client used by generated scripts.
- `src/web/server.ts`: Git POST routes, NDJSON stream and project trust PATCH.

### Web client

- `web/lib/types.ts`: `ProjectRow.gitTrusted`.
- `web/lib/api.ts`: enriched Git types, operation stream and askpass answer APIs.
- `web/lib/git-remote-output.ts` (new): Zed remote-output formatting and PR/MR URL extraction.
- `web/components/common/Toast.tsx`: action-capable status toasts.
- `web/components/workbench/git-panel-model.ts` (new): pure grouping/button/confirmation rules.
- `web/components/workbench/GitChangeList.tsx` (new): sections, tri-state stage controls, row menu and inline diff host.
- `web/components/workbench/GitCommitArea.tsx` (new): message, commit options, last commit and uncommit.
- `web/components/workbench/GitRemoteButton.tsx` (new): remote split button and picker.
- `web/components/workbench/GitAskpassModal.tsx` (new): password/passphrase prompt.
- `web/components/workbench/GitOutputDialog.tsx` (new): View Log.
- `web/components/workbench/GitPanel.tsx`: orchestration and existing focus/filter compatibility.
- `web/components/workbench/Workbench.tsx`: pass and update trust state.

### Tests and docs

- `tests/web/project-git-trust.spec.ts` (new)
- `tests/web/project-git-ops.spec.ts` (new)
- `tests/web/git-askpass.spec.ts` (new)
- `tests/web/server-project-git-actions.spec.ts` (new)
- `web/lib/git-remote-output.spec.ts` (new)
- `web/components/workbench/git-panel-model.spec.ts` (new)
- `web/components/workbench/git-panel-actions.spec.tsx` (new)
- Modify existing Git hardening, sync, diff, filter, environment-panel and product UI tests.
- `docs/web.md`: routes, trust, askpass and writable Git panel.

---

### Task 1: Trust-aware Git command foundation and Zed status model

**Files:**
- Modify: `src/harness/workspace/types.ts:14-31`
- Modify: `src/harness/workspace/service.ts:409-431`
- Modify: `src/web/project-git.ts`
- Modify: `src/capabilities/shell/detect.ts`
- Modify: `tests/web/project-git-hardening.spec.ts`
- Modify: `tests/web/project-git-sync.spec.ts`
- Modify: `tests/web/project-git-diff.spec.ts`
- Create: `tests/web/project-git-trust.spec.ts`

**Interfaces:**
- Produces: `ProjectRecord.gitTrusted?: boolean`
- Produces: `WorkspaceService.setProjectGitTrusted(id, workspaceId, trusted): Promise<ProjectRecord>`
- Produces: `projectGitEnvironment(root): Promise<Readonly<Record<string, string>>>`
- Produces: `buildGitCommand(root, args, options): Promise<ChildProcessWithoutNullStreams>` where `options = { trusted: boolean; stdin?: 'pipe' | 'ignore'; env?: Readonly<Record<string,string>> }`
- Produces: `runGitQuery(root, args, trusted): Promise<{ stdout: Buffer; stderr: Buffer; code: number }>`
- Produces: enriched `GitStatusReport`, `GitChange` and `GitBranchReport` used by every later task.
- [ ] **Step 1: Write backward-compatible trust persistence tests**

Add cases that load a project JSON without `gitTrusted`, assert it is untrusted, toggle it, reload the service, and assert it persists:

```ts
expect(service.getProject(project.id, ws.id).gitTrusted).toBeUndefined()
await service.setProjectGitTrusted(project.id, ws.id, true)
expect(reloaded.getProject(project.id, ws.id).gitTrusted).toBe(true)
await reloaded.setProjectGitTrusted(project.id, ws.id, false)
expect(reloaded.getProject(project.id, ws.id).gitTrusted).toBe(false)
```
- [ ] **Step 2: Write command-builder trust tests**

In `project-git-trust.spec.ts`, create a hostile repo with fsmonitor, hooks, credential helper, custom sshCommand, external diff and textconv markers. Assert:

```ts
await runGitQuery(repo, ['status', '--porcelain=v1'], false)
expect(await markerNames(repo)).toEqual([])
await runGitQuery(repo, ['status', '--porcelain=v1'], true)
expect(await markerNames(repo)).toContain('fsmonitor')
```

Also inspect a test seam `gitCommandArgs(args, trusted)` and pin exact order:

```ts
expect(gitCommandArgs(['diff', '--', 'a.txt'], false)).toEqual([
  '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false',
  '--no-optional-locks', '--no-pager',
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=ssh',
  '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never',
  '-c', 'diff.external=', 'diff', '--no-ext-diff', '--', 'a.txt',
])
```
- [ ] **Step 3: Write login-shell environment test**

Expose a test seam `parseNullEnvironment(Buffer)` and pin NUL parsing, duplicate `=` and empty values. Then use a temporary HOME with a shell startup file setting `DNT_GIT_ENV_SENTINEL=from-login-shell`; call `projectGitEnvironment(repo)` and assert the sentinel and `PATH` exist.
- [ ] **Step 4: Write Zed status-model tests**

Build real repository states and assert:

```ts
expect(change('staged.txt')).toMatchObject({ staging: 'staged', created: false })
expect(change('partial.txt')).toMatchObject({ staging: 'partial' })
expect(change('untracked.txt')).toMatchObject({ staging: 'unstaged', created: true })
expect(report.branch).toMatchObject({ name: 'main', upstreamTrack: { kind: 'tracked', ahead: 1, behind: 2 } })
expect(report.head).toMatchObject({ subject: 'latest', hasParent: true })
```

Keep `status` for existing consumers, add raw `indexStatus`/`worktreeStatus`, and derive `created`, `deleted`, `conflicted`, `staging` exactly from Zed `status.rs:144-203`.
- [ ] **Step 5: Run foundation tests and verify RED**

Run:

```bash
pnpm vitest run tests/web/project-git-trust.spec.ts tests/web/project-git-hardening.spec.ts tests/web/project-git-sync.spec.ts tests/web/project-git-diff.spec.ts
```

Expected: failures for missing trust methods, command helpers and enriched report fields.
- [ ] **Step 6: Implement project trust persistence**

Add to `ProjectRecord`:

```ts
gitTrusted?: boolean
```

Add to `WorkspaceService`:

```ts
async setProjectGitTrusted(id: ProjectId, workspaceId: WorkspaceId, trusted: boolean): Promise<ProjectRecord> {
  const record = this.getProject(id, workspaceId)
  const updated: ProjectRecord = { ...record, gitTrusted: trusted }
  this.projects.set(id, updated)
  await writeJson(this.projectPath(record.workspaceId, id), updated)
  return updated
}
```
- [ ] **Step 7: Implement the login-shell environment loader and command builder**

Export a platform shell detector that returns the account shell (`$SHELL`, macOS Directory Services fallback, `/bin/sh`; Windows PowerShell). Use `spawn` with the shell's login command to run `cd -- <quoted-root>; env -0`, parse NUL records, cache promises by real root, and fall back to `{ ...process.env }` after logging failure.

Build arguments exactly as the Global Constraints specify. Insert `--no-ext-diff` immediately after `diff` only when untrusted. Use the Git executable resolved against the captured `PATH`.
- [ ] **Step 8: Replace status parsing with Zed-equivalent porcelain and branch queries**

Use:

```ts
['status', '--porcelain=v1', '--untracked-files=all', '--no-renames', '-z', '--', '.']
```

Parse every two-character XY code without rename continuation records because `--no-renames` is set. Query branch/upstream with `symbolic-ref --short -q HEAD`, `for-each-ref`, and latest commit with `log -1`. Preserve top-level `branch`, `ahead`, `behind` compatibility fields for `EnvironmentPanel` while adding:

```ts
interface GitBranchReport {
  name: string
  upstream?: { remote: string; branch: string }
  upstreamTrack: { kind: 'tracked'; ahead: number; behind: number } | { kind: 'gone' } | { kind: 'none' }
}
```
- [ ] **Step 9: Run tests and verify GREEN**

Run the Step 5 command. Expected: PASS.
- [ ] **Step 10: Commit**

```bash
git add src/harness/workspace/types.ts src/harness/workspace/service.ts src/capabilities/shell/detect.ts src/web/project-git.ts tests/web/project-git-trust.spec.ts tests/web/project-git-hardening.spec.ts tests/web/project-git-sync.spec.ts tests/web/project-git-diff.spec.ts
git commit -m "feat(git): add trust-aware Zed command foundation"
```

---

### Task 2: Repository operation queue, commands, remote resolution and OS trash

**Files:**
- Create: `src/web/project-git-ops.ts`
- Create: `tests/web/project-git-ops.spec.ts`
- Modify: `src/web/project-git.ts` only to export shared path/runner types needed by operations.

**Interfaces:**
- Consumes: `buildGitCommand`, `runGitQuery`, `gitStatus`, `contain`, `GitStatusReport` from Task 1.
- Produces: `GitOperationRequest` discriminated union.
- Produces: `GitOperationResult = { ok: boolean; stdout: string; stderr: string; status: GitStatusReport; cancelled?: true }`.
- Produces: `runProjectGitOperation(root, trusted, request, askpass?): Promise<GitOperationResult>`.
- Produces: `listProjectGitRemotes(root, trusted, branch, push): Promise<string[]>`.
- Produces: `pushedTo(root, trusted): Promise<string[]>`.
- [ ] **Step 1: Write real-repository tests for stage, unstage and serialization**

Pin exact commands via an injected runner and verify real results:

```ts
await run({ type: 'stage', paths: ['a.txt'] })
expect((await status()).changes.find(c => c.path === 'a.txt')?.staging).toBe('staged')
await run({ type: 'unstage', paths: ['a.txt'] })
expect((await status()).changes.find(c => c.path === 'a.txt')?.staging).toBe('unstaged')
```

Start two delayed injected operations and assert their process intervals do not overlap for one root but do overlap for different roots. Create `.git/index.lock`, run stage, and assert Git's lock stderr is returned unchanged.
- [ ] **Step 2: Write path-option and discard/trash tests**

Create files `-rf`, `a b.txt`, tracked modified/deleted, staged-added and untracked. Assert `-rf` stages as a path. Assert discard unstages staged entries, checks tracked entries out from HEAD, reload is observable through status, and trash removes the untracked file while leaving ignored files alone.

Use an injectable `trashPath` in tests to move files into a temporary trash directory, then assert the file is recoverable there.
- [ ] **Step 3: Write commit/amend/signoff/skip-hooks/uncommit tests**

Create pre-commit and commit-msg hooks and assert:

```ts
expect((await commit({ noVerify: false })).ok).toBe(false)
expect((await commit({ noVerify: true })).ok).toBe(true)
expect(logBody()).toContain('Signed-off-by:')
expect((await amend()).ok).toBe(true)
await uncommit()
expect(await headSubject()).toBe('parent')
expect(await stagedPaths()).toContain('a.txt')
```

Verify Commit Tracked stages tracked changes but leaves untracked files out.
- [ ] **Step 4: Write remote resolution and operation tests**

Use local bare remotes. Cover:

- no upstream → `--set-upstream`;
- gone upstream → Republish path;
- tracked upstream → exact `<local>:<upstream>` refspec;
- Push To picks the supplied remote;
- Force Push uses `--force-with-lease`;
- Pull uses no `--ff-only` and Pull Rebase adds `--rebase`;
- Fetch all uses `fetch --all`; Fetch From uses `fetch <remote>`;
- `pushedTo()` drops `origin/HEAD`.
- [ ] **Step 5: Run operation tests and verify RED**

```bash
pnpm vitest run tests/web/project-git-ops.spec.ts
```

Expected: module not found.
- [ ] **Step 6: Implement the queue and operation discriminated union**

Define requests explicitly:

```ts
type GitOperationRequest =
  | { type: 'stage' | 'unstage' | 'discard' | 'trash'; paths: readonly string[] }
  | { type: 'stage-all' | 'unstage-all' | 'uncommit' | 'fetch-all' }
  | { type: 'commit'; message: string; amend: boolean; signoff: boolean; noVerify: boolean; tracked: boolean }
  | { type: 'fetch'; remote: string }
  | { type: 'pull'; remote: string; branch?: string; rebase: boolean }
  | { type: 'push'; remote: string; branch: string; upstreamBranch: string; setUpstream: boolean; force: boolean }
```

A `Map<string, Promise<unknown>>` chains jobs per real root; failure must not poison the next job.
- [ ] **Step 7: Implement commands exactly as the spec table**

Use `update-index --add --remove --` for paths and stage-all by enumerating status entries not fully staged, not by substituting a different command. Use `reset --quiet --` for unstage. Commit Tracked first stages non-created entries, then calls commit. Discard first unstages entries with `hasStaged`, then runs `checkout HEAD --` for tracked entries. Never pass untrusted client strings before `--` unless they are validated remote/branch names returned by Git.
- [ ] **Step 8: Implement remotes, pushed-to and OS trash**

`listProjectGitRemotes` first uses `rev-parse <branch>@{push}` for push or `config --get branch.<branch>.remote` for pull; if absent, deduplicate names from `remote -v`. `pushedTo` uses the command in the spec.

Implement:

```ts
async function trashPath(abs: string): Promise<void> {
  if (process.platform === 'darwin') return exec('/usr/bin/trash', [abs])
  if (process.platform === 'linux') return exec('gio', ['trash', abs])
  return powershellRecycle(abs)
}
```

Use argument arrays, never shell interpolation. On macOS prefer `/usr/bin/trash` (present on current macOS); fallback to Finder `osascript` only when unavailable.
- [ ] **Step 9: Run operation tests and verify GREEN**

Run Step 5. Expected: PASS.
- [ ] **Step 10: Commit**

```bash
git add src/web/project-git.ts src/web/project-git-ops.ts tests/web/project-git-ops.spec.ts
git commit -m "feat(git): port Zed repository operations"
```

---

### Task 3: Askpass socket, GPG wrapper and cancellation (hard task — Opus 5.5)

**Files:**
- Create: `src/web/git-askpass.ts`
- Create: `src/web/git-askpass-client.mjs`
- Create: `tests/web/git-askpass.spec.ts`
- Modify: `src/web/project-git-ops.ts`

**Interfaces:**
- Consumes: command builder and operation runner from Tasks 1-2.
- Produces: `AskpassFrame = { type: 'askpass'; promptId: string; operation: string; prompt: string }`.
- Produces: `createAskpassSession(operation, onPrompt): Promise<AskpassSession>`.
- Produces: `AskpassSession.env: Readonly<Record<string,string>>`, `.answer(promptId,password)`, `.cancel(promptId)`, `.run(child)`, `.dispose()`.
- Produces: process-global `answerGitAskpass(promptId, answer): boolean` for the HTTP route.
- [ ] **Step 1: Write script/socket round-trip tests**

Create a session, spawn `node src/web/git-askpass-client.mjs --askpass=<socket> "Password:"`, wait for an `AskpassFrame`, answer `secret`, and assert stdout is exactly `secret` with no log containing it.
- [ ] **Step 2: Write multi-prompt and cancellation cleanup tests**

Drive two prompts in one session (username then password). Assert IDs differ and answers go to the right socket connection. Cancel the second prompt and assert:

```ts
expect(result).toMatchObject({ cancelled: true })
expect(child.killed).toBe(true)
expect(promptRegistrySize()).toBe(0)
await expect(fs.access(session.tempDir)).rejects.toThrow()
```

Repeat with the simulated NDJSON consumer aborting before answering.
- [ ] **Step 3: Write GPG-wrapper generation tests**

Export `generateGpgWrapperScript(gpg, client, socket)`. Assert the script contains all three Zed stages in order: `--pinentry-mode error`, default invocation, then `--pinentry-mode loopback --passphrase-fd 3`, and only intercepts signing flags.
- [ ] **Step 4: Write operation integration test**

Inject a fake Git executable that invokes `$GIT_ASKPASS "Password:"`, then succeeds only for `secret`. Run a push operation through `runProjectGitOperation`, answer the emitted prompt, and assert success. Cancel and assert `cancelled: true` rather than an error toast payload.
- [ ] **Step 5: Run askpass tests and verify RED**

```bash
pnpm vitest run tests/web/git-askpass.spec.ts
```

Expected: module not found.
- [ ] **Step 6: Implement Unix askpass**

Use `mkdtemp`, `net.createServer`, mode `0o700` on the temp directory and `0o700` on the script. One socket connection reads until NUL, creates a random prompt ID, sends the frame, waits for an answer, writes only the answer bytes, then ends. Register cancellation before emitting the prompt to avoid a race.

The client parses `--askpass=<path>`, joins remaining arguments with NUL, appends NUL, writes to the socket, pipes the complete response to stdout, and exits nonzero on connection/read failure.
- [ ] **Step 7: Implement Windows named-pipe equivalent**

Use `\\.\pipe\dnt-harness-askpass-<random>` and set `DNT_HARNESS_ASKPASS_PIPE`. Generate a `.cmd` wrapper invoking `node <client> --askpass=<pipe> %*`. The same protocol and tests are platform-gated.
- [ ] **Step 8: Implement the GPG wrapper and command integration**

Port the Zed script body verbatim, replacing paths with shell-quoted values. Only set `GIT_CONFIG_COUNT/KEY_0/VALUE_0` when the environment has no existing `GIT_CONFIG_COUNT`. Set `GIT_ASKPASS`, `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`; push stdin is ignored. Do not add a timeout.
- [ ] **Step 9: Implement guaranteed cleanup**

`run(child)` races child output against cancellation. Cancel kills the process tree (`SIGTERM`, then `SIGKILL` fallback; `taskkill /T /F` on Windows). A `finally` closes server/connections, rejects pending prompts, clears registry entries and recursively removes temp files.
- [ ] **Step 10: Run askpass and operation tests**

```bash
pnpm vitest run tests/web/git-askpass.spec.ts tests/web/project-git-ops.spec.ts
```

Expected: PASS.
- [ ] **Step 11: Commit**

```bash
git add src/web/git-askpass.ts src/web/git-askpass-client.mjs src/web/project-git-ops.ts tests/web/git-askpass.spec.ts tests/web/project-git-ops.spec.ts
git commit -m "feat(git): add Zed-compatible askpass sessions"
```

---

### Task 4: Writable Git HTTP API, trust PATCH and NDJSON operation stream

**Files:**
- Modify: `src/web/server.ts:6976-7019,7021-7079`
- Create: `tests/web/server-project-git-actions.spec.ts`
- Modify: `tests/web/folder-grants-auth.spec.ts` or add equivalent auth cases to the new test.

**Interfaces:**
- Consumes: trust service, status, operations and askpass registry from Tasks 1-3.
- Produces: `PATCH …/projects/:pid { gitTrusted }`.
- Produces: `POST …/projects/:pid/git/:op` NDJSON stream.
- Produces: `POST …/projects/:pid/git/askpass/:promptId` JSON response.
- [ ] **Step 1: Write route/auth tests**

Create a server and project, then assert:

```ts
expect(await patchTrust(false /* bearer/non-browser */)).toHaveStatus(401)
expect(await patchTrust(true /* browser */)).toMatchObject({ gitTrusted: true })
expect(await postUnknown()).toHaveStatus(404)
expect(await getAction()).toHaveStatus(405)
expect(await postPathEscape()).toHaveStatus(400)
```

Verify archived workspaces cannot mutate Git.
- [ ] **Step 2: Write NDJSON success/failure tests**

POST stage and parse line frames. Assert the last frame is:

```ts
{ type: 'done', ok: true, stdout: '', stderr: '', status: expect.any(Object) }
```

Install a failing hook, POST commit and assert HTTP remains 200 while `done.ok === false` and stderr contains the hook output. Cancellation returns `{ type: 'done', ok: false, cancelled: true }`.
- [ ] **Step 3: Write askpass endpoint and disconnect tests**

Start an operation that prompts. Assert the stream emits `askpass`, POST the answer with the owning browser session, and assert completion. A different/non-browser principal receives 401. Abort the stream and assert the child is killed and a late answer receives 404.
- [ ] **Step 4: Run server tests and verify RED**

```bash
pnpm vitest run tests/web/server-project-git-actions.spec.ts
```

Expected: 404/405 because routes do not exist.
- [ ] **Step 5: Implement `gitTrusted` PATCH**

Validate boolean, require active workspace and `browserPrincipal`, call `setProjectGitTrusted`, and return the updated project. Preserve all existing path/name/additionalDirectory mutation ordering.
- [ ] **Step 6: Implement action parsing and NDJSON streaming**

Match the action path before the existing `…/git` read route. Validate request bodies into the Task 2 union. Write headers:

```ts
res.writeHead(200, {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
})
```

Write one JSON object plus `\n` per frame. Register `req.once('close', cancel)` and remove it after completion. Never write after `res.destroyed || res.writableEnded`.
- [ ] **Step 7: Implement askpass answer route**

Require the same browser principal and active workspace. Parse exactly one of `{ password: string }` or `{ cancel: true }`, cap password body through existing request-size limits, call the registry, and answer 404 for expired IDs. Never echo the password.
- [ ] **Step 8: Run server tests and verify GREEN**

Run Step 4. Expected: PASS.
- [ ] **Step 9: Commit**

```bash
git add src/web/server.ts tests/web/server-project-git-actions.spec.ts tests/web/folder-grants-auth.spec.ts
git commit -m "feat(web): expose streamed Git panel actions"
```

---

### Task 5: Web API types, Zed panel model and remote output formatting

**Files:**
- Modify: `web/lib/types.ts:417-427`
- Modify: `web/lib/api.ts:527-650`
- Create: `web/lib/git-remote-output.ts`
- Create: `web/lib/git-remote-output.spec.ts`
- Create: `web/components/workbench/git-panel-model.ts`
- Create: `web/components/workbench/git-panel-model.spec.ts`
- Modify: `web/components/chat/environment-panel.spec.tsx`
- Modify: `web/lib/product-ui.spec.tsx`

**Interfaces:**
- Produces: `GitOperationFrame`, `GitOperationInput`, `GitRemoteOutput`.
- Produces: `gitOperation(workspaceId, projectId, input, onAskpass): Promise<GitOperationDone>`.
- Produces: `answerGitAskpass(...)`, `updateProjectGitTrust(...)`.
- Produces pure helpers: `groupChanges`, `stageIntent`, `headerToggleState`, `commitButton`, `remoteButton`, `confirmationForEntries`.
- Produces: `formatRemoteOutput(action, output): GitSuccessMessage`.
- [ ] **Step 1: Port Zed remote-output tests verbatim**

Cover GitHub, GitLab and Bitbucket PR/MR links, unrelated URLs outside `remote:` lines, already-up-to-date fetch/pull/push, fast-forward, merge and rebase result messages.
- [ ] **Step 2: Write model tests from Zed rules**

Pin:

```ts
expect(groupChanges(changes).map(g => g.title)).toEqual(['Conflicts', 'Tracked', 'Untracked'])
expect(stageIntent('partial')).toBe('stage')
expect(commitButton({ conflicts: true, ... })).toEqual({ enabled: false, title: 'You must resolve conflicts before committing' })
expect(remoteButton({ kind: 'tracked', ahead: 2, behind: 3 })).toMatchObject({ label: 'Pull', ahead: 2, behind: 3 })
expect(remoteButton({ kind: 'gone' }).label).toBe('Republish')
```

Also pin up to five filenames plus `and N more…` confirmation details.
- [ ] **Step 3: Write NDJSON client parser tests**

Mock a `ReadableStream` split across arbitrary chunk boundaries. Assert it reconstructs lines, calls `onAskpass`, posts the answer, handles Cancel, and throws `HttpError` for pre-stream HTTP errors.
- [ ] **Step 4: Run client/model tests and verify RED**

```bash
pnpm vitest run web/lib/git-remote-output.spec.ts web/components/workbench/git-panel-model.spec.ts
```

Expected: module not found.
- [ ] **Step 5: Implement enriched client types and NDJSON parser**

Add `gitTrusted?: boolean` to `ProjectRow`, mirror Task 1 Git report types, and implement incremental `TextDecoder` parsing. Do not buffer the whole response before askpass; process each newline frame immediately.
- [ ] **Step 6: Implement pure panel rules**

Translate the named Zed functions directly: `Section.contains`, `StageIntent.resolve_with`, `header_state`, `configure_commit_button`, `commit_button_title`, `primary_changes_action_stages`, and `render_remote_button` selection. Keep functions free of React and network calls.
- [ ] **Step 7: Implement remote-output formatter**

Port `out.rs` messages and URL extraction. Return:

```ts
interface GitSuccessMessage {
  message: string
  log?: { stdout: string; stderr: string }
  action?: { label: string; url: string }
}
```
- [ ] **Step 8: Update old fixtures and run tests**

Update Git report fixtures with `gitTrusted`, `staging`, `created`, branch tracking/head fields where required. Run Step 4 plus:

```bash
pnpm vitest run web/components/chat/environment-panel.spec.tsx web/lib/product-ui.spec.tsx
```

Expected: PASS.
- [ ] **Step 9: Commit**

```bash
git add web/lib/types.ts web/lib/api.ts web/lib/git-remote-output.ts web/lib/git-remote-output.spec.ts web/components/workbench/git-panel-model.ts web/components/workbench/git-panel-model.spec.ts web/components/chat/environment-panel.spec.tsx web/lib/product-ui.spec.tsx
git commit -m "feat(web): add Zed Git panel client model"
```

---

### Task 6: Change-list UI, sections, staging and destructive actions

**Files:**
- Create: `web/components/workbench/GitChangeList.tsx`
- Create: `web/components/workbench/git-panel-actions.spec.tsx`
- Modify: `web/components/workbench/GitPanel.tsx`
- Modify: `web/components/workbench/git-panel-filter.spec.tsx`

**Interfaces:**
- Consumes: report/actions/model helpers from Tasks 4-5.
- Produces: `GitChangeList` props `{ report, visibleChanges, pendingStages, onStage, onDiscard, onTrash, onOpenFile, openPath, onToggleDiff }`.
- Produces: optimistic `pendingStages: ReadonlyMap<string, GitStaging>` owned by `GitPanel`.
- [ ] **Step 1: Write section and tri-state UI tests**

Mount a report with conflict, tracked, partial and untracked entries. Assert section order, checkbox `aria-checked="mixed"`, row checkbox labels, and section checkbox indeterminate state.
- [ ] **Step 2: Write optimistic stage and rollback tests**

Click a partial row: checkbox becomes selected before mocked `gitOperation` resolves. Reject the operation: checkbox returns to mixed and error toast is shown. Resolve: response status replaces report and pending override clears.
- [ ] **Step 3: Write split-button/menu and confirmation tests**

Assert primary header label Stage All when any unstaged entry exists and Unstage All otherwise. Assert menu item disabling. Click Discard/Trash and verify exact Zed confirmation text, 5-name detail cap, Cancel causes no operation, and confirm sends exact paths.
- [ ] **Step 4: Run UI tests and verify RED**

```bash
pnpm vitest run web/components/workbench/git-panel-actions.spec.tsx web/components/workbench/git-panel-filter.spec.tsx
```

Expected: missing sections/actions.
- [ ] **Step 5: Extract the list without regressing inline diff**

Move `ChangeRow`, `DiffView`, opener constants and diff-loading behaviour into `GitChangeList.tsx`. Keep `focusPath` scroll contract and hover overlays byte-for-byte unless a new control requires a named group. Checkboxes occupy the explicit right-side control slot; hover-only menus remain absolute and invisible when hidden.
- [ ] **Step 6: Implement sections and staging actions**

Render only non-empty Conflicts, Tracked and Untracked sections. A partial row toggles toward staged. Section checkbox stages/unstages only entries in that section. Header Stage All/Unstage All acts on every report entry exactly through the dedicated operations.
- [ ] **Step 7: Implement discard/restore/trash menus and confirmations**

Use existing `ConfirmDialog`. For a mixed selection, send tracked paths to discard and untracked paths to trash sequentially through the panel queue. Keep filtered mode scoped to visible paths for list/header actions.
- [ ] **Step 8: Run UI tests and verify GREEN**

Run Step 4. Expected: PASS.
- [ ] **Step 9: Commit**

```bash
git add web/components/workbench/GitChangeList.tsx web/components/workbench/GitPanel.tsx web/components/workbench/git-panel-actions.spec.tsx web/components/workbench/git-panel-filter.spec.tsx
git commit -m "feat(web): port Zed Git change list actions"
```

---

### Task 7: Commit area, remote controls, askpass modal and action toasts

**Files:**
- Create: `web/components/workbench/GitCommitArea.tsx`
- Create: `web/components/workbench/GitRemoteButton.tsx`
- Create: `web/components/workbench/GitAskpassModal.tsx`
- Create: `web/components/workbench/GitOutputDialog.tsx`
- Modify: `web/components/workbench/GitPanel.tsx`
- Modify: `web/components/workbench/Workbench.tsx`
- Modify: `web/components/common/Toast.tsx`
- Extend: `web/components/workbench/git-panel-actions.spec.tsx`
- Modify: `web/components/ui/ui.mounted.spec.tsx` if action toasts change shared rendering.

**Interfaces:**
- Consumes: `gitOperation`, trust API, model and remote output formatter.
- Produces: action-capable toast API:

```ts
notify(text: string, kind?: ToastKind, options?: {
  action?: { label: string; onClick: () => void }
  persistent?: boolean
}): number
```

- Produces: full Git panel interaction.
- [ ] **Step 1: Write commit-area tests**

Cover exact button labels/disabled titles, Cmd/Ctrl+Enter, Commit Tracked leaving untracked files untouched, Amend loading/restoring message, Signoff persistence, Skip Hooks reset after successful commit, error preserving message, success clearing it, and conflict warning.
- [ ] **Step 2: Write uncommit tests**

Without pushed refs, click Uncommit and assert immediate operation. With pushed refs, assert exact Zed prompt and only confirm sends uncommit. Successful result restores previous message into the editor.
- [ ] **Step 3: Write remote-control tests**

Cover Fetch/Push/Pull/Publish/Republish main button selection, spinner and disabled menu while pending, menu actions, one-remote auto-select, multi-remote picker, no push confirmation, Force Push using `force: true`, and Pull Rebase using `rebase: true`.
- [ ] **Step 4: Write askpass and toast tests**

Emit an askpass frame and assert modal operation/prompt plus masked single-line input. Confirm posts password and clears local state; Cancel posts cancel. Verify errors show `git <action> failed` with View Log, cancellation is silent, success messages/actions come from `formatRemoteOutput`, and a PR URL opens from the toast action.
- [ ] **Step 5: Run interaction tests and verify RED**

```bash
pnpm vitest run web/components/workbench/git-panel-actions.spec.tsx web/components/ui/ui.mounted.spec.tsx
```

Expected: missing commit/remote/askpass components and toast action support.
- [ ] **Step 6: Implement action-capable toasts and output dialog**

Extend `ToastItem` with one optional action while preserving existing callers and duplicate collapse. A persistent toast has no auto-dismiss timer. `GitOutputDialog` shows stdout then stderr in a focusable monospace scroller with Close.
- [ ] **Step 7: Implement askpass modal**

Use `Modal` with Git icon, operation heading, exact prompt, password input, Confirm and Cancel. If the prompt contains Password/Username and github.com, show Zed's hint and Learn more link. Never store the answer beyond the awaited callback.
- [ ] **Step 8: Implement commit area**

Use model helper result for button title/disabled reason. Implement split menu toggles. Preserve initial message when entering amend and restore it on exit. Use HEAD subject and `hasParent` for last-commit row. Filtered turn mode hides commit and remote controls, preserving the spec decision that index-wide actions cannot claim to be turn-scoped.
- [ ] **Step 9: Implement remote button and output handling**

Main and menu behaviour follows model helpers. Remote picker is a modal/list using remotes from server. Feed askpass callbacks into `gitOperation`. On done: update status, show error/cancel/success exactly as tests pin, and expose View Log / PR action.
- [ ] **Step 10: Wire trust banner and Workbench project state**

Add `gitTrusted` to `WorkbenchProject`. Banner text is `Restricted Mode`; Trust PATCHes the project then updates local panel state without requiring an app reload. Reverting trust is available in the changes action menu as `Restrict Git` so the persisted state remains controllable.
- [ ] **Step 11: Run interaction tests and verify GREEN**

Run Step 5. Expected: PASS.
- [ ] **Step 12: Commit**

```bash
git add web/components/common/Toast.tsx web/components/ui/ui.mounted.spec.tsx web/components/workbench/GitCommitArea.tsx web/components/workbench/GitRemoteButton.tsx web/components/workbench/GitAskpassModal.tsx web/components/workbench/GitOutputDialog.tsx web/components/workbench/GitPanel.tsx web/components/workbench/Workbench.tsx web/components/workbench/git-panel-actions.spec.tsx
git commit -m "feat(web): complete Zed Git panel workflow"
```

---

### Task 8: Documentation, compatibility sweep and full verification

**Files:**
- Modify: `docs/web.md:187,867,927-931`
- Modify: any compile-broken Git fixture discovered by typecheck, limited to adding the new required fields.
- No new feature files.

**Interfaces:**
- Consumes: completed feature.
- Produces: documented and verified repository state.
- [ ] **Step 1: Update web documentation**

Replace every claim that the Git view is read-only. Document GET status/diff, POST operation/askpass routes, Restricted Mode, login-shell environment, hook behaviour, NDJSON askpass and OS trash. State that actions are direct user UI actions and keep existing auth/CSRF.
- [ ] **Step 2: Run all Git-focused tests**

```bash
pnpm vitest run \
  tests/web/project-git.spec.ts \
  tests/web/project-git-diff.spec.ts \
  tests/web/project-git-hardening.spec.ts \
  tests/web/project-git-sync.spec.ts \
  tests/web/project-git-trust.spec.ts \
  tests/web/project-git-ops.spec.ts \
  tests/web/git-askpass.spec.ts \
  tests/web/server-project-git-actions.spec.ts \
  tests/web/server-project-files.spec.ts \
  web/lib/git-remote-output.spec.ts \
  web/components/workbench/git-panel-model.spec.ts \
  web/components/workbench/git-panel-filter.spec.tsx \
  web/components/workbench/git-panel-actions.spec.tsx \
  web/components/chat/environment-panel.spec.tsx \
  web/lib/product-ui.spec.tsx
```

Expected: PASS.
- [ ] **Step 3: Run typecheck and fix fixture-only fallout**

```bash
pnpm run typecheck
```

Expected: PASS. Fix only genuine interface mismatches and old fixtures; do not weaken types with optional fields unless the server can truly omit them.
- [ ] **Step 4: Run the complete suite**

```bash
pnpm test
```

Expected: PASS.
- [ ] **Step 5: Build the web surface**

```bash
pnpm run build:web
```

Expected: Vite exits 0 and writes `web-dist`.
- [ ] **Step 6: Manual browser smoke test**

Run `pnpm web`, open this repository's Git panel, and verify: Restricted Mode banner; Trust; staged/partial/untracked states; Commit with a real hook; Skip Hooks; Uncommit; Fetch; askpass modal if a test remote is available; Discard confirmation; Trash sends a test file to macOS Trash; PR-link toast from a fixture remote. Check console errors at desktop and tablet widths.
- [ ] **Step 7: Commit docs/compatibility fixes**

```bash
git add docs/web.md web tests src
git commit -m "docs(web): document writable Zed Git panel"
```

Do not include unrelated pre-existing modified files in this commit.

---

## Plan Self-Review

- **Spec coverage:** Sections 1-10 map to Tasks 1-8; askpass/GPG/trust/trash/remote output all have owning tasks and tests.
- **Scope:** Stash, branch picker, History/Graph, View Diff multibuffer, co-authors, AI message, ignore actions, init/clone remain excluded exactly as the spec states.
- **Type consistency:** `gitTrusted`, `GitStatusReport`, `GitOperationRequest`, `GitOperationResult`, `AskpassFrame` and the NDJSON done frame are defined once and consumed by named later tasks.
- **Review Focus:** all five risks have explicit tests in Tasks 1-5.
- **Placeholder scan:** no TBD/TODO/later steps remain.
