# Phase 01 — Outbound transport security: report

## Design

- `src/harness/mcp/outbound-http.ts`: `OutboundHttp` loads real Undici through `undici/package.json` → `main` (never the bare specifier). It fails closed if fetch is the native/global fetch or the Agent has no callable `dispatch`. There is one Agent per mode (`public`, `loopback`), with an explicit `close()`. The envelope runs `assertOutboundUrl`, then picks the dispatcher, then sends with `redirect:'manual'` and one signal combining the caller signal and `timeoutMs`. That signal stays on the body.
- Connect-time DNS: each Agent's `connect` calls `resolvePolicyAddress` (in `outbound-policy.ts`) and dials the vetted IP. The original `host` is kept, so SNI and certificate verification are unchanged. Any prohibited answer rejects the whole set (mixed answers). Every new connection resolves again.
- The process-wide singleton `defaultOutboundHttp()` is shared by all hosts and never closed by a host shutdown (spec: do not close another host's pool). Process exit frees it.
- Test seams: `sender` (final send, under the envelope), `loader` and `resolver`, all constructor-only. RH1-F wiring tests forbid `new OutboundHttp(`, `fetchImpl`, a bare `undici` value import, and `fetch(` in mcp/connect sources.
- Media: `fetchMedia(url, base, { gateway, http })`. The configured origin uses the operator gateway fetch and its credentials only while the chain has never left that origin. After the first foreign hop, every hop goes through the public-only policy transport with no credentials. Bounded to 5 redirects; intermediate bodies are cancelled.
- LLM gateways (`src/harness/llm/*`, image/video provider POSTs) are unchanged.

## Evidence

- `bun run typecheck`: exit 0.
- Affected tests (Node 22.20): 8 directly changed or new files: 159 pass, 1 skip (existing win32 skip). Wider sweep of 31 MCP/OAuth/image/web files: only the baseline failures (mcp-resilience ESRCH ×3, g3-context ×1).
- Full suite, 2 runs: 26 failed files each. Non-baseline failures differ between runs (compaction-benchmark/plugins timeouts and git-v2 EBUSY in run 1; server-model-alias and project-git-test-isolation in run 2). All pass in isolation and none use the HTTP MCP, OAuth or media paths, so they are classed as load flakes.
- Bun probe `scripts/outbound-http-probe.mjs` (also run by `runtime-probes.mjs` and by `tests/harness/outbound-http.spec.ts`): 13/13 PASS on Bun 1.4.3.

## Open

- RH1-G (public HTTPS MCP, OAuth refresh/revoke, media bytes under Bun) is not run; it needs network.
- The Linux CI run of the probes is pending a push.
- Real-world TLS through the custom connect is covered only by the unchanged Undici connector code path. It has not been exercised against a real cert in tests.
