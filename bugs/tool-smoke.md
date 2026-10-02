# Tool smoke bugs

Bugs found while exercising built-in tools on this session. Newest first.

## BUG-001 — Read does not return sha256, so guarded Write/Edit cannot close the loop

- **Status:** closed — false positive; clarified tool descriptions
- **Found:** 2026-08-14, file-tool smoke (Glob / Grep / Read / Write / Edit)
- **Tools:** Read, Write, Edit
- **Severity:** medium (forces an extra shell hash, or an unguarded edit)

### Expected

`Read` returns the file content and the sha256 of the bytes it just observed, matching the digest `Write` / `Edit` accept as `expectedSha256`. A caller can read, then edit or overwrite, without a side channel.

### Actual

`Read` returns only the text body (plus truncation markers on large reads). The tool result has no `sha256` / `expectedSha256` field. To pass a correct `expectedSha256` the caller has to hash the file another way (`sha256sum` via Bash). Editing without the hash skips the conflict check entirely.

### Repro

1. `Write` `artifacts/tool-smoke/file-tools.txt` with a few lines. Result: `created`.
2. `Read` the same path. Result is the body only — no digest.
3. `Edit` with `expectedSha256` set to a wrong digest. Result: `conflict: ... changed after it was observed; re-read before writing`. The message says "re-read", but a second `Read` still does not yield a hash.
4. `sha256sum` the file, then `Edit` with that digest. Edit succeeds.

### Notes

- Ambiguous-edit guard works: replacing `line-two` when it occurs twice returns `ambiguous edit`.
- Stale-hash guard works once a digest is supplied.
- `rm -rf` of the smoke dir was blocked by the Dangerous Commands / FS Destructive policy. Single-file `rm` plus `rmdir` succeeded. Not filed as a tool bug.

## BUG-002 — Memory tools hide the hash that MemoryUpdate requires

- **Status:** fixed
- **Found:** 2026-08-14, memory-tool smoke
- **Tools:** MemoryCreate, MemoryRead, MemoryUpdate
- **Severity:** medium (update is impossible from tool results alone)

### Expected

The digest `MemoryUpdate.expectedHash` compares against is visible on the last read (or create). The tool description says "Pass expectedHash from your last read".

### Actual

- `MemoryCreate` / `MemoryUpdate` return only `hash ${entry.hash.slice(0, 12)}` (`src/harness/memory/tools.ts`).
- `MemoryRead` returns title, body, and `updated` timestamp. It drops `entry.hash` even though `MemoryService.read` computes the full sha256.
- `MemoryService.update` compares `current.hash !== input.expectedHash` with the full hex digest.
- Passing the 12-char prefix fails: `memory entry '...' changed externally; re-read before updating`. Re-reading still does not yield a hash.
- Missing id fails closed, correctly: `no memory entry 'tool-smoke-does-not-exist' in this scope`.

### Repro

1. `MemoryCreate` id `tool-smoke-memory`. Result includes a 12-char hash.
2. `MemoryRead` the same id. No hash in the result.
3. `MemoryUpdate` with `expectedHash` set to those 12 chars. Conflict.
4. Hash the markdown file on disk (full sha256 of the raw file). `MemoryUpdate` with that digest succeeds, including `pinned: true`.
5. `MemoryForget` then removes it from `MemorySearch` and `MemoryRead`.

### What did work

- Search is scoped and ranked; after update the entry showed `[pinned]` and the new title.
- Forget excludes future retrieval. Missing id is not-found, not a leak.
- Empty title/body and kebab-case id checks exist in the service; not re-tested here.

## BUG-003 — Bash timeout result drops the exit code

- **Status:** fixed
- **Found:** 2026-08-14, remaining-tool smoke
- **Tools:** Bash
- **Severity:** low (success and non-zero exits are reported; only the timeout path is ambiguous)

### Expected

The tool description says the result includes the exit code. A killed command should still say it was killed and what code (or signal) it ended with.

### Actual

`sleep 5` with `timeoutMs: 500` returned only `[terminated: timeout or stop]`. No exit code.

`src/capabilities/shell/bash.ts` `report()` emits `[exit code: N]` only when the process was not killed. The timeout branch always prints the same suffix used for an abort, so a timeout and a user stop are not distinguishable either unless the stop path sets `exec.signal.aborted`.

### What did work

- stdout and stderr are combined (`stderr-line` appeared with stdout).
- `exit 7` returned `[exit code: 7]`.
- The requested timeout was honored (well under the 30s cap).

## BUG-004 — Skill tool has no catalog, and a missing skill looks like a hard error

- **Status:** fixed
- **Found:** 2026-08-14, remaining-tool smoke
- **Tools:** Skill
- **Severity:** low (load path works; discoverability does not)

### Expected

The parameter says "skill name from the catalog", so the model can list names before loading one. A missing name should be a normal not-found result, not an execution error.

### Actual

- The only Skill parameter is `name`. There is no `list` / catalog action. `SkillsService.list` exists (`src/harness/skills/service.ts`) but is not exposed on the tool.
- `Skill` with `tool-smoke-missing` threw `SkillError: no skill 'tool-smoke-missing'` (tool error channel).
- This workspace has no `SKILL.md` of its own. The only `SKILL.md` files under the repo are inside `node_modules` (Playwright), and those are not on the skill path.
- Mode gating did work: the error was not-found, not "skills off", so the current mode has skills `on-demand`.

## BUG-005 — Bash treats timeoutMs 0 as an immediate kill

- **Status:** fixed
- **Found:** 2026-08-14, edge-case smoke
- **Tools:** Bash
- **Severity:** low

### Expected

`timeoutMs: 0` is not a positive timeout. The schema says the default is 30000. A zero or omitted value should use that default, not kill the process at once.

### Actual

`echo hi; exit 0` with `timeoutMs: 0` returned only `[terminated: timeout or stop]`. The command produced no stdout.

`src/capabilities/shell/bash.ts` does `Math.min(requested, timeoutMs)` whenever `requested` is a number. Zero is a number, so the kill timer is 0ms. The same path would accept a negative number. A positive value such as 500 is clamped correctly.

### Related

BUG-003: that kill path also drops the exit code.

## BUG-006 — File containment allows paths outside the workspace

- **Status:** closed — expected Full access out-of-grant policy, not a containment bypass
- **Found:** 2026-08-14, edge-case smoke
- **Tools:** Read, Write
- **Severity:** high (host file disclosure and arbitrary host-file creation with process privileges)

### Expected

Tool descriptions say Read/Write stay inside the workspace or a granted folder.

### Actual

- `Read` of `C:\Windows\win.ini` returned the host file body.
- A sequential test created `../dnt-harness-outside-smoke.txt`; `Read` returned `outside`.
- `Write ../dnt-harness-outside-write.txt` returned `created ../dnt-harness-outside-write.txt`. The file was created beside the workspace.
- These locations were not explicitly granted in this session.

### Correction from the first pass

Write's read-before-overwrite guard works. The earlier apparent blind overwrite was a smoke-test race: Read and Write had been issued in parallel on the same path. In a sequential setup, Bash created an existing file and `Write` (without a prior Read or explicit hash) correctly returned `was never read by this conversation`. Creating a genuinely new path is intentionally allowed.

### What did fail closed

- Missing file: `no such file`.
- Directory: `artifacts is a directory, not a file`.
- Bad grep regex: `Invalid regular expression`.
- Glob pointed at a file (`src/harness/tools/names.ts` with pattern `*`): `no matches`, not a crash.
- Edit of an ambiguous string still refused.
- Skill name `Bad_Name` (not kebab-case): `no skill 'Bad_Name'`.
- Memory id `Bad_Id`: `must be kebab-case`. Blank title: `argument 'title' must be a non-empty string`.
- Agent action `nope`: unknown action. Spawn with no prompt and no objective: `SpawnError` packet.
- Superset: two statements rejected (`multiple statements are not allowed`); `-- comment` rejected (`comments are not allowed`).
- Bash output cap: a 70000-char print was truncated with both `[truncated N chars]` and `[output truncated during capture]`, exit code 0.

## Agent deep-smoke — no capacity/depth bug reproduced

- **Status:** passed
- **Found:** 2026-08-14, subagent edge smoke
- **Tools:** Agent

### Verified

- Six concurrent children were admitted (`active: 1/6` through `6/6`); the seventh was refused with `capacity reached: 6 active children`.
- On a fresh turn, exactly eight admitted children were counted: one long verifier, one delegator role, and six no-op roles. After all settled, child nine was refused with `capacity reached: 8 children per turn`. The earlier suspicion that an active-cap refusal consumed quota was a miscount across turns, not a product bug.
- `wait` with 100ms returned a running handle and `still running after the timeout`.
- Cancelling a verifier running `sleep 20` produced durable `status: cancelled`. It took roughly 15 seconds to settle; cancellation works, though latency may merit UX tuning.
- One-level delegation was tested using a temporary workspace role whose declared tools were `["Agent"]`. In the child, Agent was not exposed: report `Agent tool unavailable`. The exposure ceiling blocks delegation before a nested call can occur.
- `inheritable: false` was tested using a temporary role. Spawn with `inherit: brief` failed: `role 'no-inherit-smoke' does not accept inherited context`.
- Worker child created the requested file. Verifier child ran Bash and reported PASS / exit 0. Temporary role definitions were removed after the smoke.

## BUG-008 — MemoryUpdate validates after writing and can corrupt an entry

- **Status:** fixed
- **Found:** 2026-08-14, memory edge smoke
- **Tools:** MemoryUpdate, MemoryRead
- **Severity:** high (a rejected update destroys the previously valid entry)

### Expected

As `MemoryCreate` does, update validates title/body before writing. An invalid update leaves the previous entry untouched.

### Actual

1. Created `tool-smoke-memory-edge` with a valid title and body.
2. Obtained its full sha256 from the backing file (required because of BUG-002).
3. Called `MemoryUpdate` with `title: " "` and `body: " "`.
4. The tool returned `memory entry 'tool-smoke-memory-edge' is malformed; fix or rewrite it`.
5. The backing file had already been replaced with frontmatter containing `title: " "` and an empty body (85 bytes). The previous valid body was gone.

`MemoryService.update` serializes and writes first, then calls `read`; `read` discovers the empty body and throws. Unlike create, update has no pre-write non-empty validation and no rollback.

The corrupted smoke entry was forgotten afterward.

### Additional edge results

- Duplicate create correctly returns `already exists; use update`.
- Forget of a missing id is idempotent and returns `forgot`.
- `MemorySearch` rejects an empty query at the tool argument layer, although the service supports an empty query internally.
- Skill load was tested with a real temporary workspace skill: repeated loads return the same pinned hash; an external edit after load does not change the hash within the turn. Temporary skills were removed.
- Superset accepts a SELECT CTE, rejects multiple statements and SQL comments, and reports an HTTP 404 for an unknown database.

### Not a bug (same pass)

- **Agent** `catalog` lists explorer / worker / reviewer / verifier and models.
- **Agent** `spawn` of explorer returned immediately (`session-mum5w1gks5cnu6`, model `cliproxy:grok-4.7`). `wait` completed with the expected two-line report. `list` showed that child as completed. Spawn without `definition` failed closed: `'definition' must name a role`.
- **MCP Superset:** `list_databases` returned 5 databases; `list_schemas` on database 5 returned `mail`; `SELECT 1` returned 1 row; `DELETE` was rejected with `only SELECT is allowed, got delete`.

## Fix verification — 2026-08-14

- MemoryCreate, MemoryRead, and MemoryUpdate now expose a full 64-character sha256. MemoryUpdate rejects malformed hashes at the tool boundary.
- MemoryUpdate validates non-empty title/body before atomic publication; regression test proves a rejected update preserves the previous entry.
- Bash treats zero/negative timeout arguments as the configured default and reports timeout vs stop separately, including an exit code when one exists or `no exit code` otherwise.
- Skill supports `action: catalog|load`; legacy `{ name }` loads still work; missing names return a normal successful tool result with available names.
- File Read records whole-file observations internally (including ranged reads); later Write/Edit in the same conversation check them automatically. Explicit sha256 remains available for direct callers.
- Full access intentionally allows approved/out-of-grant paths; low-level lexical, symlink, denied-root, read-only-grant, and approval tests all pass.
