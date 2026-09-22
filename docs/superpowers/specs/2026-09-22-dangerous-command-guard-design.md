# Dangerous Command Guard — Design

**Date:** 2026-09-22
**Status:** Approved
**Author:** mini-dsh team
**Scope:** Harness + Web Settings — single spec (one subsystem, one file boundary)

---

## 1. Context & Goals

`Bash` is currently gated only by Mode-level `toolExposure` + `permissionDefaults` (`allow | ask | deny`). The gate does not inspect `command` content, so `ls -la` and `rm -rf /` share the same policy. `full-access` allows everything; the ask-modes ask for everything.

**Goals**

- Differentiate Bash commands by risk and enforce per-command `deny | ask | allow` before the approval waterfall.
- Provide 6 curated preset groups (toggle on/off, choose action) so most users never write a regex.
- Allow custom rules (substring or regex) that override presets, including allow-listing a narrow exception.
- Make the guard workspace-scoped with a global default, live without restart, and fully auditable via the existing durable log.
- Ship a Settings UI that is usable by non-technical users.

**Non-goals (V1)**

- No inspection of `Write | Edit | Read | Glob | Grep` — path guards already cover filesystem.
- No OS sandbox, no shell AST parsing, no anti-obfuscation (e.g. `eval $(echo cm0gLXJm | base64 -d)`).
- No per-project rule, no per-agent/role override, no `python -c "os.system(...)"` interception.
- No change to `BUNDLED_MODES` or `permissionDefaults` semantics.

---

## 2. Architecture

### 2.1 Placement

```
Model → Agent turn → tools.prepare(call)
                         │
              tools/rewrite  ←── dangerousCommandGuard (NEW, first listener)
                         │
              tools/pre-execute  ←── attachApproval (Mode/permission)
                         │
              requiresRoot check → tool.execute (spawn bash -lc)
                         │
              tools/post-execute
```

A single `tools/rewrite` listener is the correct seam: it rewrites or denies **before** the approval waterfall, so a `deny` never creates an `approval/request`, and an `ask` is forced even when the Mode says `allow`. This reuses `ToolsService.prepare`'s two-phase flow (`rewrite` then full `pre-execute` chain) and the durable `tool/call → tool/result` + `approval/request → approval/decision` audit already in place.

The guard lives in `src/harness/guard/dangerous-commands.ts` (new directory `guard/` — keeps harness top-level tidy). It is mounted by the host composition (like `attachApproval`), not by `ToolsService` itself.

### 2.2 Component boundaries

| Unit | Responsibility | Public surface |
|------|---------------|----------------|
| `DangerousCommandsConfig` | Typed config + defaults | `type PresetId`, `type GuardAction = 'deny'|'ask'|'off'`, `type CustomRule`, `DEFAULT_CONFIG` |
| `DangerousCommandsStore` | File IO: global + workspace JSON | `load(workspaceId): Config`, `save(workspaceId, config)`, `loadGlobal(): Config`, `saveGlobal(config)` |
| `DangerousCommandMatcher` | Normalize + match one command against config | `match(command: string, config): Match | null` where `Match = { presetId?, ruleId?, action, reason }` |
| `attachDangerousCommandGuard(ctx, options)` | `tools/rewrite` listener wiring | `options.configSource: () => Config` (live getter) |

Each unit is independently testable: matcher is pure, store is file IO with atomic replace, guard is a single waterfall listener.

---

## 3. Data Model & Storage

### 3.1 File locations

- Workspace config: `<home>/workspaces/<wsId>/dangerous-commands.json`
- Global default: `<home>/dangerous-commands.json` (alongside `app.json`)

Workspace file absent → inherit a deep clone of the global file; global absent → `DEFAULT_CONFIG`. First workspace save materializes the file (override).

### 3.2 Schema

```json
{
  "v": 1,
  "presets": {
    "fsDestructive": "deny",
    "gitDestructive": "ask",
    "systemPriv": "ask",
    "networkExfil": "deny",
    "dbDestructive": "ask",
    "resourceExhaust": "deny"
  },
  "customRules": [
    {
      "id": "cr-01",
      "pattern": "rm -rf ./tmp",
      "isRegex": false,
      "action": "allow",
      "description": "Allow cleaning tmp in CI"
    }
  ]
}
```

- `presets` values: `'deny' | 'ask' | 'off'`. Missing key → default from `DEFAULT_CONFIG`.
- `customRules[]` ordered; `id` is `cr-<nanoid>` generated on creation.
- `isRegex=false` → case-insensitive substring (`includes` on normalized command). `true` → `RegExp` compiled with `i` flag; invalid regex rejected at save boundary.
- Validation: unknown preset keys rejected, invalid `action` rejected, empty `pattern` rejected, `customRules` length capped at 100.

### 3.3 Defaults (`DEFAULT_CONFIG`)

```ts
presets: {
  fsDestructive: 'deny',
  gitDestructive: 'ask',
  systemPriv: 'ask',
  networkExfil: 'deny',
  dbDestructive: 'ask',
  resourceExhaust: 'deny',
}
customRules: []
```

---

## 4. Preset Groups

| Id | Name | Representative patterns | Notes |
|----|------|------------------------|-------|
| `fsDestructive` | `rm -rf`, `rm -r`, `mkfs`, `dd if=`, `shred`, `chmod -R 777`, `> /dev/sd*`, `mv /*` | Irreversible filesystem damage |
| `gitDestructive` | `git reset --hard`, `git push --force` / `--force-with-lease`, `git clean -fdx`, `git branch -D`, `git stash clear` / `drop`, `git restore` (without `--staged`, or with `--source`+`--worktree`), `git checkout -- .` | `git stash push/list/show`, `git restore --staged` are safe — explicitly excluded via negative lookahead / anchored regex |
| `systemPriv` | `sudo`, `su `, `systemctl`, `reboot`, `shutdown`, `taskkill /F`, `net stop` | Privilege escalation / host control |
| `networkExfil` | `curl | sh`, `wget | bash`, `curl -o | sh`, `nc -l`, `ssh `, `scp `, `Invoke-Expression`, `iex(` , `certutil -urlcache` | Remote exec / exfiltration |
| `dbDestructive` | `DROP TABLE`, `DROP DATABASE`, `TRUNCATE TABLE`, `DELETE FROM` without `WHERE` | Data loss |
| `resourceExhaust` | `:(){ :|:& };:`, `fork bomb`, `nohup` + infinite loop, `:(){` | Host DoS |

Each preset is an array of `RegExp` (compiled once at matcher init). The displayed reason names the preset, e.g. `matched Git Destructive (git stash clear)`.

---

## 5. Matching & Enforcement

### 5.1 Normalization

```
trim → collapse internal whitespace (/\s+/g → ' ') → strip trailing comment ( / #.*/ not inside single/double quotes)
→ lower-case for keyword comparison (original preserved for reason display)
```

No shell tokenization; single-pass string normalization. Documented limitation: obfuscated payloads bypass the guard.

### 5.2 Priority

1. **Custom rules** — evaluated in array order; first match wins. A custom `deny` beats everything; a custom `allow` can exempt a command that a preset would deny.
2. **Presets** — if no custom matched, test each preset whose setting is not `off` (order: `fsDestructive → networkExfil → resourceExhaust → gitDestructive → systemPriv → dbDestructive` — destructive first for reason clarity). First preset match wins.
3. **No match** → `null` (pass through — defer to Mode/approval).

### 5.3 Enforcement actions

| Match action | Guard behavior |
|--------------|---------------|
| `deny` | Return `{kind:'deny', reason:'blocked by Dangerous Commands: matched <Preset/Rule> (<pattern>) — <description>'}`. No `spawn`, no `approval/request`. Durable `tool/result ok:false` visible to model. |
| `ask` | Return `{kind:'allow', call}` but set a per-call flag so `attachApproval`'s `forceAsk` sees it. Practically: the guard stores the match in a `WeakMap<ToolCall, Match>` and `forceAsk` reads it. The approval card renders the match reason as a red banner. If the Mode already denies `Bash`, the deny still wins (guard never upgrades a deny). |
| `allow` | Return `{kind:'allow', call}` — no forceAsk. |

**Invariant:** The guard never widens a Mode denial. If `toolExposure` excludes `Bash` or `permissionDefaults` denies it, that decision stands regardless of guard config.

### 5.4 Interaction with `forceAsk` and `reevaluate`

`attachApproval` already accepts `forceAsk?: (call) => boolean`. The guard wires it as:

```ts
forceAsk: (call) => dangerousMatchFor(call)?.action === 'ask'
```

Pending `ask` approvals created via the guard participate in `ApprovalHandle.reevaluate` like any other — a Mode change that removes `Bash` from exposure cancels them; a config change that flips a preset to `off` would allow a re-evaluated pending `ask` to proceed (guard re-checks on reevaluate).

---

## 6. Settings UI

**Location:** New tab `Dangerous Commands` in Settings (alongside Modes, Agents, MCP). Chosen over merging into Modes because the guard is a security concern, not a Mode tuning.

**Layout:**

- Header: short explanation + link to docs.
- **Presets section:** 6 rows, each with `Name — description` on the left, a 3-state segmented control `Deny | Ask | Off` on the right, plus a muted example line.
- **Custom Rules section:** table `Pattern | Type (Text/Regex) | Action | Description | Actions (edit/delete)`, plus `Add rule` button.
  - Add/Edit opens a small form: `pattern` (text input, live regex validation when `isRegex` on), `isRegex` toggle, `action` select, `description` optional.
- **Test bar** (bottom): input `Try a command…` + `Test` → inline result: `Matched <Rule/Preset> → DENY/ASK` or `No match — allowed by Mode`.
- Footer: `Save` / `Cancel` (dirty check). Save does `PUT /api/guard/dangerous-commands` with `expectedHash` for conflict detection.

**Visual treatment:** follows `docs/design-system.md` — `Stack`, `SectionHeader`, `ListItemRow`, semantic tokens only. Dangerous `deny` rows use `text-bad`, `ask` uses `text-warn`.

---

## 7. API

| Method | Path | Body | Notes |
|--------|------|------|-------|
| `GET` | `/api/guard/dangerous-commands?workspaceId=...` | — | Returns `{config, hash}`. Workspace inherits global when absent (hash is global hash). |
| `PUT` | `/api/guard/dangerous-commands` | `{workspaceId, config, expectedHash?}` | Validates schema + regex; `409 Conflict` on hash mismatch; writes atomically via `replaceFileAtomic`. |
| `GET` | `/api/guard/dangerous-commands/global` | — | Global config (admin/global scope). |
| `PUT` | `/api/guard/dangerous-commands/global` | `{config, expectedHash?}` | Same validation. |

All routes require workspace scoping (`requireActive` for PUT). Host wires `configSource` as a live getter reading the workspace file (cached per-request, not per-process).

---

## 8. Error Handling

- **Invalid regex in custom rule:** rejected at PUT with `400` and field-level error; UI shows inline validation before save.
- **Corrupt JSON on disk:** treat as `DEFAULT_CONFIG` for reads, surface a warning toast; next save overwrites atomically.
- **Missing workspace file:** inherit global — not an error.
- **`spawn` never reached on guard deny:** no orphan process concern; `killTree` unchanged.
- **Guard throws:** fail closed — catch and return `deny` with `reason: 'guard error: ...'` so the command does not run.

---

## 9. Testing

- **Unit — matcher:** each preset has positive/negative fixtures (e.g. `git restore --staged` must NOT match gitDestructive; `git restore foo.txt` must match). Custom rule priority, substring vs regex, normalization edge cases, case-insensitivity, comment stripping.
- **Unit — store:** global vs workspace inheritance, atomic write, corrupt file fallback, hash conflict detection.
- **Integration — guard pipeline:** `ToolsService` with guard + approval: `deny` blocks before approval, `ask` forces ApprovalBar, `allow` exempts, Mode deny still wins, `reevaluate` after config change.
- **API — e2e:** GET/PUT happy path, 400 on invalid regex, 409 on hash conflict, 404 on unknown workspace.
- **UI — component:** preset toggle, custom rule CRUD, Test bar, dirty/save flow (Vitest + Testing Library; Playwright for the Settings tab navigation).

---

## 10. Rollout

1. Guard ships **enabled with defaults** (table in §3.3). Existing workspaces without a file inherit defaults — no migration needed.
2. No data migration; `v:1` schema leaves room for future preset additions (new preset defaults to `ask`).
3. Document limitation (no AST, no obfuscation resistance) in `docs/harness.md` and Settings header.

---

## 11. Alternatives Considered

- **Blocklist inside `bashTool`:** not workspace-scoped, not configurable, bypasses the approval waterfall's durable audit.
- **Extend Mode `permissionDefaults` to command content:** breaks the Mode contract (tool-name keyed) and complicates Mode files.
- **Shell AST parsing:** over-engineering for V1; regex + normalization covers ~95% of real accidental damage.

---

## 12. Open Decisions (resolved)

- Preset defaults as in §3.3 — FS/Network/Resource `deny`, Git/System/DB `ask`.
- Git preset includes `git stash clear/drop` and `git restore` (with safe exclusions) per request.
- Custom rule supports both `contains` (isRegex=false) and `RegExp` (isRegex=true).
- Settings is a dedicated tab, not merged into Modes.
