# File tool reliability (Read / Write / Edit)

Status: implemented (uncommitted), live on PM2 · 2026-10-01

Verification: full suite 1284/1284, `tsc --noEmit` clean, new
`tests/capabilities/fs-text-document.spec.ts` (17 cases); Read-format
assertions updated in 7 existing specs. Baseline from
`node scripts/tool-health.mjs`: Edit 263/1073 (24.5%). Re-run with
`--since 2026-10-01T09:20` after real usage to measure against the < 3% target.

## Evidence

Session logs (`~/.dnt-harness/data`, 165 sessions): Edit failed 246 / 1018 (24%),
Write 11 / 107, Read 25 / 3236. 173 Edit failures were "not found":

- 116 matched the last Read once `\n` → `\r\n` (CRLF file, LF `old`).
- 43 more matched an earlier Read after the same conversion (windowed re-read).
- ~11 were genuine model mistakes.

Root cause: no single definition of "file text" — Read returned raw bytes
(with `\r`, BOM), the model writes LF text, Edit matched raw bytes.

Reference: ZCode v3.14.3 (`apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`,
`edit-matchers.ts`, `adapters/src/fs/text-metadata.ts`) normalizes CRLF→LF for the
model and restores EOL/encoding on write, prints `N\tline`, and uses ordered,
uniqueness-checked fallback matchers.

## Design

1. `fs/text-document.ts` — the only byte boundary: decode (BOM, UTF-8/UTF-16LE,
   binary refusal, EOL detection) to LF text + an offset map; splice edits back
   into the raw bytes so everything outside the edited span is byte-identical
   (mixed-EOL files stay mixed); Write re-encodes with the file's EOL/BOM.
2. Read contract — `N\tline`, default 2000-line window, long-line cap,
   continuation footer with the next offset.
3. `fs/edit-match.ts` — exact → line-number-prefix stripped → trailing-whitespace
   tolerant → indentation-flexible (re-indents the replacement) → quote-normalized.
   Every step must be unique; fuzzy steps are off for `replace_all`. No
   similarity/anchor matching (silent wrong edits). Not-found errors show the
   closest region with line numbers.
4. Observations — content-hash check (kept: stricter than mtime); children
   inherit the parent's observations read-only (still hash-checked).
5. Contract — Claude-style aliases (`file_path`, `old_string`, `new_string`,
   `replace_all`) normalized at the canonical-call boundary; `expectedSha256`
   hidden from the model schema; `old === new` rejected; clean error text.
6. Lease — "project busy" was already removed at 1ef09da; nothing to do.
7. Measurement — `scripts/tool-health.mjs` reports per-tool failure rates and
   categories from session logs. Target: Edit failure < 3%.

## Deferred

- Persisting observations across a host restart (needs a session-event field;
  `events.ts` is being changed by another work stream).
- Structured error codes on `ToolResult`.
