# Migration notes — runtime & provider hardening

Applies to the release after 0.3.0 (commits `2ff6eff..` on `main`). Nothing
rewrites user config or session logs. Every change below is either opt-in or
backwards-readable.

## Runtimes

- Bun **1.4.3** is the declared minimum (`engines.bun >=1.4.3`) and the version
  CI pins. It is the version verified for real-Undici outbound policy and PTY
  teardown. Bun 1.3.x is no longer supported.
- Developing from source: Vitest and Vite run under Node **>= 22.19** (22.20 LTS
  or 24). This is a development-only requirement, so it is not declared in
  `engines` (installing the package needs only Bun). `bun run test` runs `scripts/node-preflight.mjs`
  first and refuses older Node or Bun.
- `bun run probe:runtime` checks the installed Bun. On Linux,
  `bun scripts/pty-probes.mjs --require` checks real PTY teardown.

## Output caps (no config change needed)

- Models with no operator `maxOutputTokens` and no catalog limit still get a
  **32 000-token fallback cap**. If the endpoint rejects it, the harness
  resends **once**, either with the limit the error names (known formats only,
  256–256 000, below what was sent) or with no cap. It remembers the result
  per route, in memory only (16-entry LRU, reset when the key, endpoint or
  model changes). The corrective resend counts as a physical attempt of the
  same logical request. The first such request fails with *"fallback
  output-cap guess (N) rejected …; the corrected cap applies to the next
  request (or set maxOutputTokens)"*.
- Catalog caps now apply to older OpenAI SKUs instead of the 32k guess:
  `gpt-4` / `gpt-4-0613` → **8192**; `gpt-3.5-turbo*`, `gpt-4-turbo*`,
  `gpt-4-0125/1106-preview`, `gpt-4o-2024-05-13` → **4096**. An operator
  `maxOutputTokens` still wins over the catalog.
- The remaining-window ceiling only lowers a cap. It no longer raises it to
  1 024. A request with no room left fails as `context_exceeded` before
  sending and goes through the existing squeeze recovery.
- A rejected operator/catalog cap is terminal ("lower maxOutputTokens"). It is
  never squeezed or retried, including when a relay wraps it in a 502.
- Not done (spec deviation): unknown-model "omit cap" and
  `fallbackMaxOutputTokens` were not implemented. The bounded-relearn
  behaviour above was kept.

## Reasoning replay (DeepSeek thinking + tools)

- The native endpoint (`api.deepseek.com`, exact host) uses a **strict
  profile**: `{ field: 'reasoning_content', required: true, replayWindow:
  'conversation' }`. Reasoning from the same route is sent back on requests
  that carry tools. A model id containing `deepseek` on another endpoint does
  **not** enable replay. A relay opts in through `providers.json`
  `reasoning: { field, required, replayWindow }` (validated; reserved keys
  refused; an invalid profile is dropped with a warning).
- Missing reasoning is **never fabricated**. If the active tool loop (since the
  last user message) lacks complete reasoning from this route, the request
  fails **before the network** with *"start a new session, or explicitly reset
  the context …"*. Causes: model/endpoint/key switch mid-loop, a reply cut off
  at `length`, or a restart without the persisted route secret. A DeepSeek 400
  ("`reasoning_content` … must be passed back") gets the same hint, with no
  retry.
- Legacy sessions (no stored reasoning) still open and list. Older turns are
  left without the field. If the live endpoint rejects that, the actionable
  400 above applies.
- **`route-identity.secret`**: a new per-install file next to `providers.json`
  (32 random bytes, mode 0600 on POSIX). It keys route fingerprints with
  HMAC, so lineage survives restarts without storing credentials. It contains
  no credential and is safe to delete; identities then change once, and an
  open tool loop asks for a new session. If the data dir is unwritable, an
  in-memory secret is used and lineage is process-local (never wrongly
  reused).
- Storage: `assistant/message` may carry an optional `reasoning` record.
  Compaction snapshots become `v: 2` only when they include reasoning. v1
  snapshots and digests validate unchanged. The SSE stream strips the stored
  record; UI thinking display is unchanged.
- **Rollback caveat:** older binaries ignore the unknown `reasoning` field, but
  their validators refuse v2 snapshot sidecars and fall back to fold/
  re-summarize. Back up the data dir before a staged rollout, and roll back
  before new writes accumulate if you need byte-identical behaviour.
- Native thinking+tools support is **not claimed** until the opt-in live smoke
  (`scripts/smoke-deepseek-reasoning.ts`, needs `DEEPSEEK_API_KEY`) passes.

## Terminal teardown

- `DELETE /api/workspaces/:wid/terminals/:tid` now **awaits** teardown:
  `200 {killed:true}` after confirmed exit, **`500 {killed:false,error}`** on a
  failed teardown (the record is kept, input refused, retry with DELETE), and
  `409` while closing. Clients that treated any response as success should
  check the status (the bundled UI already does).
- POSIX: close PTY → HUP to the shell and its session members → KILL after
  1 s. Shutdown awaits all terminals (4 s budget) within a 13.5 s host
  deadline (PM2 `kill_timeout` 15 s).
- **Limitation:** an external SIGKILL or host crash during teardown can leave
  shells/jobs running. There is no orphan reaping. Detached daemons are never
  cleaned up.
- Support: Windows has smoke evidence, Linux is gated by CI probes
  (pending their first green CI run), and
  **macOS is unverified (not claimed)**.

## Outbound policy (MCP HTTP, OAuth, foreign media)

- Policy-owned requests use **real Undici**, loaded through
  `undici/package.json` → `main`. Under Bun the bare `undici` import is a native
  shim that ignores dispatchers. The transport fails closed if the real module
  cannot be loaded. There is no fallback to native fetch.
- DNS is checked **at connect time** on every new connection. Private, link-local,
  CGNAT, NAT64/6to4-embedded and mapped addresses are blocked. A mixed
  public/private answer rejects the whole set. SNI and certificate checks are
  unchanged.
- **Localhost:** plain HTTP and loopback destinations work only for a
  configured loopback resource (the local fixture profile: `localhost`,
  `127.0.0.1`, `::1`). Every DNS answer must then be loopback. `localhost` is
  otherwise prohibited, and a public-looking name that resolves to loopback
  or private space is blocked. MCP/OAuth redirects are still refused.
- **Media redirects** (image/video tools): at most 5 hops, each validated, with
  intermediate bodies cancelled. Hops on the configured provider origin use the
  operator's gateway fetch and credentials only while the chain has never left
  that origin. After the first foreign hop, every hop (even one back to the
  configured origin) uses the public-only transport with **no credentials**.
- LLM gateway endpoints are unchanged. Private gateways the operator
  configured keep working.

## Benchmark scripts

- `scripts/e2e/compare-opencode-dnt.mjs` **never** resets, restores, checks
  out, adds or deletes in a source repo.
  - `--repo-copy <src>` freezes the source with hardened read-only Git (no
    hooks/fsmonitor/filters/optional locks/index refresh, absolute git, no
    transports). It then builds an **independent, HEAD-only** repo per
    contestant/run: a shallow HEAD commit plus separate index and worktree
    layers, verified before any agent runs. There is no history, no other
    refs and no remotes. Untracked files are copied only with
    `--include-untracked`. Ignored files are never copied.
  - **Refused:** ordinary checkouts passed to `--repo` (it accepts only
    disposable targets the script created, matched against its registry),
    submodules, unmerged entries, partial clones, symlinks/invalid paths on
    Windows, and sensitive tracked paths (`.env*`, `*.pem`, `*.key`, …) in
    HEAD or the index. A source that changes during the freeze aborts.
  - Drift in a target fails the run (nonzero exit) and preserves the artifact.
    A copy is **not a sandbox**: an agent running as the same OS user can
    still reach the source by absolute path.
- `scripts/bench/run-bench.mjs` metrics are normalized per record
  (`cachedTokens ?? cachedInputTokens`, finite and nonnegative only, missing =
  **unknown**, not 0). Input semantics are labelled: dnt input is inclusive of
  cache, opencode input is non-cached; compare the "In incl." column. Failed
  and timed-out runs stay in the success denominator, with `validRuns` and
  exclusion reasons shown. Read-task verifiers check the expected answer.
