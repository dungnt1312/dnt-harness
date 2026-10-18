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

## Reasoning replay (any OpenAI-compatible provider)

Modelled on opencode's OpenAI-chat adapter: no host list, no per-provider
switch.

- **Capture**: thinking is read from the configured field, then
  `reasoning_content`, `reasoning`, `reasoning_text`. The first field that
  carries text is stored with the reasoning (`reasoning.field`) on the
  `assistant/message`, for every provider. A reply without thinking stores
  no record (never an empty one).
- **Replay**: every assistant message of every request (with or without
  tools, so the prompt-cache prefix stays stable) carries its complete
  reasoning. The field is chosen as configured field → the field observed on
  this provider/model's own stream → `reasoning_content`. A session that only
  ever used an endpoint without reasoning sends no reasoning field. Reasoning
  is counted in the context budget, so thinking-heavy sessions reach
  compaction sooner than before.
- **`requireReasoning`**: a message with no reasoning still gets `""`. On by
  default for DeepSeek (provider name `deepseek`, a `deepseek.com` base URL
  or a model id containing `deepseek`) and whenever `reasoningField` is set;
  off otherwise.
- **Switching models**: the readable text crosses over to the new
  provider/model under its configured field or `reasoning_content` (opencode
  parity). A key rotation or a `baseUrl` edit keeps the provider id and so
  keeps the observed field.
- **Opt-out**: `replayReasoning: false` for an endpoint that streams reasoning
  but refuses it as input. Reasoning is still recorded, never sent.
- A reply cut off at `length` is stored as `complete: false` and never
  replayed. There is no pre-network gate: an endpoint 400 such as
  "`reasoning_content` … must be passed back" is classified
  `reasoning_replay_rejected`, not retried, and suggests a new session.
- **Configuration** (optional, `providers.json` only; no REST/UI field yet),
  same names as opencode: `compatibility: { reasoningField?,
  requireReasoning?, replayReasoning? }`. Reserved message keys (and the
  structured `reasoning_details`) are refused. An invalid value is warned
  about, not applied, and written back unchanged on save; keys dnt does not
  use are kept too. A phase-05 `reasoning: { field, required: true }` entry
  is read as `{ reasoningField: field, requireReasoning: true }`, and
  `required: false` as `{ replayReasoning: false }`; it is rewritten as
  `compatibility` on the next save.
- **`route-identity.secret`** (per-install, next to `providers.json`) still
  keys learned output caps. Reasoning no longer depends on it.
- Storage: `assistant/message` may carry an optional `reasoning` record
  (`text`, `field?`, `complete`, `source`, `redacted?`). Records written
  before `field` existed stay valid. Compaction snapshots become `v: 2` only
  when they include reasoning; v1 snapshots and digests validate unchanged.
  The SSE stream strips the stored record; UI thinking display is unchanged.
- **Rollback caveat:** older binaries ignore the unknown `reasoning` field, but
  their validators refuse v2 snapshot sidecars and fall back to fold/
  re-summarize. Since any provider that streams reasoning now writes v2
  snapshots (not only DeepSeek with tools), more sessions are affected. Back
  up the data dir before a staged rollout. A phase-05 binary also reads
  `compatibility` as unknown and loses a migrated `reasoning` override.
- Live behaviour is **not claimed** until the opt-in smoke
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
