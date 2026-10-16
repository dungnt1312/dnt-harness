# File tools: dnt-harness vs ZCode

## Scope and evidence

Comparison only, 2026-10-15. Local six tools: Read, Write, Edit, ApplyPatch, Glob, Grep. Source: https://github.com/zai-org/ZCode, local checkout /private/tmp/zcode-research, HEAD aac4755666d09fdcd70272fcf063c077a639015f. This is a pinned checkout, not a verified latest upstream revision. ZCode root LICENSE is Apache-2.0; no code copied. Any future copying must preserve applicable license/notice obligations.

Local source: src/capabilities/fs/{tools,search,grep-worker,text-document,observation,patch-match}.ts. ZCode paths below are relative to apps/zcode-cli/packages/.

## Remaining gaps

| Priority | Area | ZCode | Local behavior and impact | Evidence |
|---|---|---|---|---|
| P1 | Grep capabilities | multiline, offset pagination, only-matching (-o), line-number toggle (-n), context alias | None exposed locally; line-by-line JS matching cannot search cross-line blocks, and capped results cannot be paged | core/src/tool/handlers/grep.ts:63-81; local tools.ts:484-525, grep-worker.ts:71-103 |
| P1 | Read media | Native image/video blocks; conditional PDF pages | Read images returns a separate vision model's description; no PDF/pages/video branch. Main model does not receive pixels through this Read path | core/src/tool/handlers/read.ts:100-133,166-179; local tools.ts:170-178; src/web/server.ts:1293-1299 |
| P1 | Truncated observation safety | Token-budget partial view marked and refused by Write/Edit; explicit ranged reads are not automatically forbidden | Local observes whole-file hash before rendering output, without visible-range/truncation metadata. A clipped Read can authorize whole-file Write. Hash protects freshness, not whether content was actually seen | core/src/tool/handlers/read.ts:365-378, edit.ts:421-435, write.ts:284; local tools.ts:177-205, observation.ts:15-27 |
| P2 | Large-file range reads | readTextFileRange; explicit line limit omits default maxBytes parameter | Local reads and hashes whole file even for a tiny range; files over 32 MiB refused. This is a capability/IO gap, not a measured performance regression | core/src/tool/handlers/read-text.ts:40-51; local tools.ts:50-54,91-97,170-180 |
| P2 | Glob patterns and ordering | ? wildcard, basename match for slashless patterns across descendants, newest mtime first | Local Glob supports *, **, braces only; '*.ts' is scoped to the root level; traversal is alphabetically ordered rather than newest-first. Local Grep glob filter separately supports ?, making the two contracts different | adapters/src/fs/index.ts:430-437,1733-1771; local search.ts:50-66,259; tools.ts:461-473 |
| P2 | Legacy encodings | Detects/round-trips GB2312, GBK, GB18030 | Local UTF-8 and BOM UTF-16LE; invalid UTF-8 is lossy/read-only. Local Grep separately skips UTF-16 files with NUL and decodes candidates as UTF-8 | adapters/src/fs/text-metadata.ts:12,29-78; local text-document.ts:75-96; grep-worker.ts:69-71 |
| P3 | Re-read token economy | Same fresh non-partial read window returns unchanged stub | Local always renders content again; no unchanged-read shortcut | core/src/tool/handlers/read.ts:185-198,335-350; local tools.ts:170-208 |
| P3 | Missing-path recovery | Similar filename suggestion | Local missing Read reports only no-such-file | core/src/tool/handlers/read.ts:401-436; local tools.ts:174 |

Additional semantic differences: ZCode Grep defaults to files_with_matches; local defaults to content. ZCode default adapter is ripgrep with JS fallback (adapters/src/fs/index.ts:452-468); local uses JS regex in a terminable worker. Do not claim regex or performance parity without a compatibility corpus and benchmarks. Local Grep count counts matching lines, not each occurrence (grep-worker.ts:73-81).

## Already covered; do not count as missing

- Structured multi-hunk/multi-file ApplyPatch, add/delete/move, verify all sections before publication.
- Read-before-mutation and SHA-256 stale checks; canonical-path locks across native mutation tools.
- Write/Edit encoding/BOM/EOL preservation, conservative Edit fallbacks, ambiguity rejection, replaceAll, numbered result snippet.
- Search gitignore/default-ignore handling, explicit overrides, incomplete/truncation warnings, Grep modes/context/type/glob/cancellation.
- ApplyPatch partial-I/O receipts, absent add/move destination checks, executable-mode preservation.

## Decision matrix and challenge

| Decision | ZCode | Local | Recommendation |
|---|---|---|---|
| Patch matching | Exact then whitespace/Unicode-normalized first match | Exact unique match; reject ambiguity | Keep local safety; tolerance is optional, not required parity |
| Existing-file patch precondition | Handler reads current file, without requiring prior conversation Read | Prior observed hash required | Keep local; do not relax for cosmetic parity |
| Patch EOF | derivePatchedContent ensures trailing LF | Preserve original final-newline state | Keep local preservation |
| Multi-file transaction | Verify then sequential IO | Verify then sequential IO, landed-change error receipt | No cross-file rollback exists locally; not a newly missing ZCode feature |
| Search engine | Ripgrep with fallback | JS worker + granted-root walker | Add needed semantics first; engine replacement needs performance evidence and grant-safety design |
| Read caching | Freshness-based unchanged stub | Repeat real content | Optional; any shortcut must respect compaction/context eviction and not hide unavailable earlier content |
| Media | Provider-visible native parts | Dedicated vision description | Native image/PDF read is valuable; preserve text-only fallback |

Suggested sequence: truncated-view safety, Grep multiline/pagination/options, native media/PDF, then Glob semantics and large-range reads. Encoding and unchanged-read optimization are demand-driven. P1/P2 denote suggested product priority, not reproduced security severity. No implementation plan or code changes were requested.

## Verification

Ran pnpm exec vitest run on fs-tools, fs-conflicts, fs-multi-root, fs-search, fs-text-document, apply-patch, and describe-image specs with --maxWorkers=1: 7 files, 101 tests passed, exit 0. Existing live smoke in this conversation also proved invalid ApplyPatch batch rejection without changing the earlier valid file, and move+edit success.

No new regression cases were added. No ZCode runtime tests, upstream refresh, full suite, UI build, typecheck, or benchmarks were run. No source files or smoke fixtures changed. Observations persistence/replay and result-artifact parity were not fully traced and are not asserted as confirmed gaps.
