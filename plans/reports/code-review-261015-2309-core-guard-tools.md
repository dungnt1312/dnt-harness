# Core guard / approval / tools / modes review — 2026-10-15

Scope: `src/harness/guard/*.ts`, `src/harness/approval/*.ts`, `src/harness/modes/*.ts`,
`src/harness/tools/*.ts`, plus the call sites that decide their outcome (`src/web/server.ts`
gate/final-gate/authority, `src/capabilities/fs/grants.ts`, `src/web/path-scope-guard.ts`,
`src/web/execution-authority.ts`) and the tests `tests/harness/guard-*.spec.ts`,
`tests/harness/modes.spec.ts`, `tests/harness/guard-pipeline.spec.ts`,
`tests/web/permission-hardening.spec.ts`.

No source file was modified; nothing was executed against the machine.

## Summary

| # | Severity | Area | Finding | file:line |
|---|---|---|---|---|
| 1 | High | Guard presets | `${IFS}` / `$' '` word separators defeat **every** preset, including the default `deny` actions | `src/harness/guard/matcher.ts:167-207`, `src/harness/guard/presets.ts:5-8` |
| 2 | High | read-only Bash lift | Argument containment ignores glob/brace metacharacters → absolute paths outside the folder pass as "read-only" | `src/harness/guard/bash-readonly.ts:49-61,117-118` |
| 3 | High | Path exceptions | `underPrefix` rejects only literal `/../`; a brace expansion hides `..` and exempts a preset match | `src/harness/guard/matcher.ts:107-136,145-156` |
| 4 | Medium | riskyBash | Unparsable lines fail **open** for every git/rsync destructive verb (only `rm\|rmdir\|dd\|shred\|mkfs\|eval` are caught) | `src/harness/guard/bash-risky.ts:177-183` |
| 5 | Low | Approval / host | A session-wide folder grant is persisted *before* the post-grant authority re-check, so a refused call can still widen the session | `src/web/server.ts:3428-3456` |
| 6 | Low | SendPreview chart | Only item *counts* are bounded; label / series-name length is unbounded | `src/harness/tools/chart-spec.ts:40,43,57-63` |
| 7 | Low | Guard store | A corrupt `dangerous-commands.json` silently drops custom rules (warning only reaches the Settings GET) | `src/harness/guard/store.ts:52-65` |
| 8 | Low | Mode parse | Duplicate frontmatter keys: last wins silently, unlike every other malformed input | `src/harness/modes/service.ts:483-499` |
| 9 | Low | Image/video tools | Provider-reported media URL is fetched with no host restriction; the `authorization` header goes to any URL merely *prefixed* by `baseUrl` | `src/harness/tools/video-tools.ts:219-222`, `src/harness/tools/image-tools.ts:189-192` |
| 10 | Low | Tool boundary | `canonicalArgs` drops a valid alias when the canonical key is present but `null` | `src/harness/tools/names.ts:43-53` |

Severity counts: **critical 0 · high 3 · medium 1 · low 6**.

## Independent re-verification of the three high findings (by the parent session)

The wired modules were imported under `/tmp` and called directly, so these are observed results, not
code reading. Control cases prove the harness was exercising the real path.

```
PRESET "rm${IFS}-rf${IFS}build" => null            <-- finding 1
PRESET "rm$' '-rf$' 'build"     => null            <-- finding 1
PRESET "rm -rf build"           => fsDestructive   (control)
EXEMPT plain  "rm -rf tmp/../src"       => fsDestructive  (control: still denied)
EXEMPT brace  "rm -rf tmp/{../src,x}"   => null           <-- finding 3: exempted, would be denied
READONLY "cat [/]etc/passwd"           => true   <-- finding 2: lifts the ask
READONLY "cat {/etc/passwd,README.md}" => true   <-- finding 2
READONLY "cat /etc/passwd"             => false  (control)
READONLY "cat src/index.ts"            => true   (control: intended behaviour)
```

Findings 1, 2 and 3 are therefore **confirmed exploitable as described**. One sub-claim did not
reproduce: `ls {-la,/etc}` returns `false`, because `isContainedPath` splits the word on `[=:,]` and
`/etc` then starts with `/`. Only the `[/]`-style and brace-of-relative-paths spellings work.

Why the severity is real rather than theoretical: `DEFAULT_CONFIG.presets.fsDestructive` is `'deny'`
(`src/harness/guard/defaults.ts:21`), and in `full-access` / `autonomous` the mode sets `Bash: 'allow'`
(`src/harness/modes/bundled.ts:118` and the `full-access` block). In those modes the guard deny preset
is the **only** thing stopping a recursive delete, so findings 1 and 3 defeat the last backstop, not a
redundant layer.

## Findings

### 1. High — preset matching is defeated by a non-whitespace word separator (`${IFS}`)

`src/harness/guard/matcher.ts:167-207` (preset path), `src/harness/guard/presets.ts:5-8`.

*What breaks.* Presets are regexes over `normalizeCommand(maskDataText(command), ' ; ')`.
`normalizeCommand` only touches newlines and runs of existing whitespace (`matcher.ts:14-67`); it
never sees the value a shell will actually produce. Every destructive preset requires a literal `\s`
before the flag: `/\brm\s+(-…r…f|…)\b/` and `/\brm\b[^|;&]*\s-(?:[a-z]*r[a-z]*|-recursive)\b/`. A
word separator that is not a literal space therefore matches nothing, so a `deny` preset (default:
`fsDestructive`, `networkExfil`, `resourceExhaust`) never fires and the Bash call is not denied — and
in Autonomous/Full access (Bash `allow`) it is the only gate.

*Trigger.* `Bash: rm${IFS}-rf${IFS}build` — bash expands to `rm -rf build`. The normalized text
contains no whitespace, so `matchCommand(..., DEFAULT_CONFIG)` is `null`. Same with ANSI-C quoting:
`rm$' '-rf$' 'build` (the parser sees `$` → `expands`, then a single-quoted region). The second
layer misses it too: `matchRiskyCommand` takes the single word `rm${IFS}-rf${IFS}build`,
`name.split('/').pop()` yields that whole string, and `invocationMatch`'s switch has no `rm` case to
hit (`bash-risky.ts:137-171`), so Autonomous mode also asks nothing.

*Minimal fix.* Either (a) pre-normalize `$'…'`/`${IFS}` in `normalizeCommand`'s unquoted-position
scan, or (b) stop relying on regex whitespace for `fsDestructive`: run the structural classifier
(`parseShell`) first and deny/ask on `words[0] ∈ {rm, rmdir, shred, dd, mkfs*, …}` regardless of
separators, keeping the regexes only for compound text. (b) is the smaller long-term change since
`bash-risky.ts` already has the unwrapping logic.

*Class note (honesty).* This is the same family as the deliberately documented non-matching fixtures
in `tests/harness/guard-matcher.spec.ts:152-161` (`'r''m' -rf`, `$(printf r)m`, interpreter
delegation). It is flagged because those fixtures are prose-shaped tricks, whereas `${IFS}` reaches
the *default deny* actions with a single, mechanical edit and no configuration change — worth a
decision and a pinning test either way.

### 2. High — argument containment in the read-only classifier ignores glob/brace metacharacters

`src/harness/guard/bash-readonly.ts:49-61` (`isContainedPath`), used at `:117-118`; lift applied at
`src/harness/modes/bash-policy.ts:19-23` and `src/web/server.ts:4046`.

*What breaks.* The module's contract is "names no path outside the project folder". `isContainedPath`
rejects `expands`, `\`, a Windows drive prefix, absolute values, `~` and `/../`, but never consults
`word.glob` — and `parseShell` sets `glob: true` for `* ? [ { }` (`shell-parse.ts:177`). Only the
*program* name is checked against `glob` (`:117`), so an argument that spelling-wise looks relative
but expands to an absolute path or a parent segment is accepted.

*Trigger.* In `ask-before-changes` or `edit-automatically` (both `readOnlyBash: allow`),
`Bash: cat [/]etc/passwd` — the word `[/]etc/passwd` is `glob: true`, its text does not start with
`/`, so `isContainedPath` returns true, `cat ∈ ANY_ARGS`, `isReadOnlyBashCommand` returns true, and
`liftsReadOnlyBash` turns the Bash `ask` into `allow`: the file is read with no approval and no
Dangerous Commands card (no preset matches `cat`). `cat {/etc/passwd,README.md}` needs no
file-system match at all (brace expansion is unconditional), and `ls {-la,/etc}` passes a
flag+absolute path the same way.

*Minimal fix.* In `isContainedPath`, add `if (word.glob) return false` (the module's own "unknown is
not safe" rule — the same posture it already takes for `expands`). One line, closes the `[/]`, `{…}`
and `*` spellings together. If some glob support is genuinely wanted, the containment must be decided
on the expansion, not the text, which is not knowable before the shell runs.

### 3. High — a brace expansion hides `..` from the per-preset path exception

`src/harness/guard/matcher.ts:131-136` (`underPrefix`), `:107-129` (`commandOperands`), `:145-156`
(`exemptByPaths`).

*What breaks.* `exemptByPaths` skips a preset match when every matched simple command's operands are
under a configured prefix. `commandOperands` only refuses operands that `expands` (`:123`) — a `glob`
operand is returned verbatim (`:122,128`) — and `underPrefix` tests for a parent escape with
`/(^|\/)\.\.(\/|$)/`, i.e. a literal `..` preceded by `/` or start-of-string. `{../src,x}` puts `..`
after `{`, so the test misses it and `startsWith('tmp/')` succeeds.

*Trigger.* With `exceptions.fsDestructive: ['tmp']` (exactly the shape in
`tests/harness/guard-matcher.spec.ts:263-299`, which already asserts that `rm -rf tmp/../src` **keeps**
the match): `Bash: rm -rf tmp/{../src,x}`. `exemptByPaths` sees one hit segment, one operand
`tmp/{../src,x}`, `underPrefix` → true, so `matchCommand` returns `null`. Bash brace-expands to
`rm -rf tmp/../src tmp/x`, deleting `src/` with no ask and no deny — in *every* mode, including Full
access where `fsDestructive: deny` is the intended backstop. Same for `find tmp/{../src,x} -delete`.

*Minimal fix.* Two options, both one-liners at the same place: reject a glob operand in
`commandOperands` (`if (operands.some((word) => word.expands || word.glob)) return undefined`), and/or
make `underPrefix` refuse any value containing `{`, `}`, `*`, `?` or `[`. The first is more faithful
to the stated fail-closed contract ("an expansion … keeps the match").

### 4. Medium — the risky-command layer fails open for every unparsable line that does not mention `rm`-family programs

`src/harness/guard/bash-risky.ts:177-183`.

*What breaks.* When `parseShell` reports `unsupported` (subshell, `$()`, backticks, heredoc, `&`),
structural analysis is abandoned and a single text regex decides:
`/(^|[\s;&|(`$])(rm|rmdir|dd|shred|mkfs(\.\w+)?|eval)(?=$|[\s;&|)`])/`. `git reset --hard`,
`git clean -fd`, forced `git push`, `git restore .`, `rsync --delete`, `find … -delete` are absent, so
in Autonomous mode (Bash `allow` + `riskyBash: ask`, `bundled.ts:99-119`) those run with no prompt at
all, while the same command without a substitution asks.

*Trigger.* `Bash: (cd repo && git clean -fdx)` — the parenthesis makes the parse `unsupported`; no
token matches the fallback regex; `matchRiskyCommand` returns `null`; `riskyBashMatch` → `null`; the
call runs. (Contrast the fully parsed `cd repo && git clean -fdx`, which is caught as
`git-clean-force`.)

*Minimal fix.* Broaden the fallback to the same vocabulary the structural rules use — e.g. a second
alternative for `git\s+(reset|clean|push|restore|checkout|branch|stash|worktree)` — or, cleaner, parse
the *outer* line, and when a command is unanalyzable, ask whenever the line mentions any program
`invocationMatch` knows about (`git`, `rsync`, `find`, `rm`, `dd`, …, `xargs`). Keep the current
behaviour only for lines naming none of them.

### 5. Low — session-wide folder grant is persisted before the post-grant authority re-check

`src/web/server.ts:3428-3456` (host-side; outside the requested file list, but on the approval path
this review covers).

*What breaks.* The `grantForSession` branch calls `mutateSessionGrants(...)` (`:3435-3441`) and only
then re-runs `hostAuthority` (`:3445-3455`); if the re-check now yields `deny`/uncovered `ask`, the
function returns an error string — but the grant is already durable. This contradicts the local
contract stated at `:3461` ("the grant itself is recorded only if the call is finally allowed, right
before it runs").

*Trigger.* Root session asks `Read /outside/file`; user answers "allow for this session"; between the
answer and dispatch the workspace mode narrows (or the guard config gains a deny), so `after.kind ===
'ask'` with no receipt: the call is refused with "requires fresh approval", yet the folder is now a
session grant and later calls read it without an approval. Impact is bounded (the human did approve
that folder), so severity is low.

*Minimal fix.* Move the `mutateSessionGrants` call after the post-check, or roll the grant back on a
non-allow result. Alternatively, do the write last inside the same `try` and record `grantForSession`
only when the second evaluation also allows.

### 6. Low — `SendPreview` chart strings are unbounded

`src/harness/tools/chart-spec.ts:40,43,57-63`; contrast `src/harness/tools/preview-tool.ts:26,28-34`.

*What breaks.* `parseChart` bounds `labels.length ≤ 500`, `series.length ≤ 8`, requires
`values.length === labels.length` and finite numbers, and caps axis titles at 60 chars — but each
`label` and each `series[].name` is only required to be a non-empty string (labelled `< 200` only in
the tool *description*). The parsed spec is returned verbatim as the tool result, so it is written to
the session log (and re-rendered by the web `ChartPreview`).

*Trigger.* A single `SendPreview` call with `labels: ["<10 MB string>"]` (repeated per point) — the
whole chart JSON becomes the durable `tool/result` and the model-visible payload; the title/caption
path deliberately caps at 200 chars, so the omission looks unintentional.

*Minimal fix.* Cap `label` (e.g. 120 chars) and `name` (e.g. 80) with the same throw-a-message pattern
already used for axis labels.

### 7. Low — a corrupt guard config silently discards custom rules

`src/harness/guard/store.ts:52-65` (and `readFile` `:114-131`).

*What breaks.* A workspace file that fails validation returns `{config: DEFAULT_CONFIG, warning}`.
Presets therefore fall back to *stricter* defaults (fail-closed), but any `customRules` deny the user
added for commands no preset covers (`kubectl delete`, `terraform destroy`, …) disappear for both the
guard's `evaluate` and the model's view. The warning is only returned on
`GET /api/guard/dangerous-commands` (rendered as an info notice,
`web/components/settings/DangerousCommandsPanel.tsx:121-125`); nothing in the tool path tells the
agent or the operator that the guard is running degraded.

*Trigger.* Any user hand-edit, partial write, or disk-level truncation of
`workspaces/<ws>/dangerous-commands.json` → next Bash call is judged against defaults only.

*Minimal fix.* Keep the fail-closed default but surface the warning through the guard handle (a
match-independent notice on the next Bash call, or a one-shot host event) so the degraded state is
visible outside Settings.

### 8. Low — duplicate frontmatter keys are silently last-wins

`src/harness/modes/service.ts:483-499` (`parseFrontmatter`).

*What breaks.* Every other malformed input is a loud `ModeError` (unknown keys, bad enums, non-boolean
flags, unknown tools, bad permission keys — `service.ts:357-467`), and the module comment promises
invalid content is "never silently coerced". A duplicated key is not in that set: the loop assigns
`result[key] = …` each time, so the final occurrence wins.

*Trigger.* A hand-edited (or merged) mode file containing

```
toolExposure: ["Read", "Grep"]
toolExposure: ["Bash"]
```

loads as `toolExposure: ["Bash"]` — a *wider* capability ceiling than the first line suggests, with no
error. Same for `permissionDefaults` and `readOnlyBash`.

*Minimal fix.* Push to `invalid` when `key in result` is already true (`'duplicate frontmatter key'`),
alongside the existing unknown-key check in `parseModeFile`.

### 9. Low — provider-named media URL is fetched without a host restriction; the `authorization` header matches on a string prefix

`src/harness/tools/video-tools.ts:219-222`; same shape in `src/harness/tools/image-tools.ts:189-192`.

*What breaks.* `target = final.videoUrl` (whatever the provider returned, bounded only by
`/^https?:\/\//i`) and the headers are `target.startsWith(base) ? headers(false) : {}`. `startsWith`
is a string test, not a host test, so `https://api.example.com.evil.tld/x` is treated as "our provider"
and receives `Authorization: Bearer <key>`. And the fetch itself will go to any host the provider names
(e.g. a link-local address), with the response stored as a video/attachment when the container sniff
passes.

*Trigger.* A compromised or MITM'd provider response (or a proxy misconfiguration) naming a foreign
URL — the only user-controlled inputs are the configured endpoint and the model's prompt, so this
needs a hostile/compromised provider; hence low.

*Minimal fix.* Compare origins instead of prefixes (`new URL(target).origin === new URL(base).origin`),
and refuse a non-same-origin download URL instead of sending credentials to it.

### 10. Low — `canonicalArgs` discards a valid alias when the canonical key exists but is `null`

`src/harness/tools/names.ts:43-53`.

*What breaks.* The alias is dropped whenever `target in args` — presence, not value. A model that
emits both spellings with the canonical one `null` loses the usable value.

*Trigger.* `Read({file_path: 'src/index.ts', path: null})` → `canonicalArgs` returns `{path: null}` →
the tool throws `argument 'path' must be a non-empty string` instead of reading the file.

> Note: the reviewer's returned text was truncated at this point (the remainder of finding 10's
> suggested fix and any closing sections were cut). Everything above finding 10 is verbatim.
