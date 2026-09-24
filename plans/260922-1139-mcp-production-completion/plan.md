---
title: "MCP Production Completion"
description: "Safety-first completion of mini-dsh MCP tools: authenticated local control plane, versioned config migration, no-replay execution evidence, hardened transports and subprocesses, desired-state reconciliation, managed OAuth, operational UI, conformance, and production rollout."
status: in-progress
priority: P1
effort: "51-77 engineering days plus cross-platform soak and canary"
tags: [mcp, security, runtime, oauth, web, conformance]
created: 2026-09-22
blockedBy: []
blocks: []
---

# MCP Production Completion

## Overview

Complete the existing G5 MCP tools implementation without replacing its working permission, workspace, mode, or child-agent contracts. The current runtime already supports stdio and Streamable HTTP, discovery/calls, approvals, encrypted secrets, health checks, circuit breaking, and basic Settings management. This plan closes the audited production blockers, adds a protected local control plane and a tested managed-OAuth profile, then proves the system through real browser-to-MCP and cross-platform failure-injection gates.

The safety kernel has four non-negotiable properties:

1. mini-dsh performs at most one automatic application-level `tools/call` dispatch per invocation;
2. failures after a conservative possible-dispatch boundary become `indeterminate`, never an automatic replay;
3. a synced execution intent exists before transport dispatch, under the one proven data-home owner and its fencing epoch;
4. config/credential mutations fence old runtime generations before acknowledging that no new dispatch can use them.

Exactly-once remote effects are not claimed unless a future server-specific idempotency contract is negotiated and tested.

## Production Scope

### Required milestone

- Route-default-deny authentication for privileged REST, SSE, approvals, terminal/agent controls, secrets, hooks, and executable MCP configuration.
- Versioned v1/v2 config compatibility, migration kernel, one data-home ownership lock/fencing epoch, and minimum safe rollback floor before changing defaults.
- Structured `indeterminate`/`audit_fault` outcomes and crash-durable MCP execution evidence.
- Strict bounded stdio/Streamable HTTP, protocol/capability validation, complete discovery pagination, standards-compliant SSE, and safe redirects/outbound network policy.
- Explicit disabled-by-default activation, minimal environment, canonical executable preview, and platform-qualified process containment/resource claims.
- Transactional desired-state reconciliation for config, secret revisions/tombstones, descriptors, and live runtime generations.
- Managed OAuth compatibility profile: authorization-code + PKCE, pinned discovery behavior, encrypted crash-safe refresh state, local-first revocation, and auth-required recovery.
- Essential Settings/diagnostics: save versus activate, trust preview, durable status, discovered/exposed tools, stale-revision handling, OAuth recovery, and indeterminate warnings.
- Pinned compatibility fixtures, a separate real-stack Playwright suite, Windows/Linux gates, quantified soak thresholds, migration/rollback drill, and live rollout evidence.

### Explicit follow-up plans, not release blockers

- MCP resources, prompts, roots, sampling, and legacy HTTP+SSE.
- Dynamic client registration or provider-specific OAuth quirks outside the pinned compatibility profile.
- Marketplace/plugin distribution (G6).
- Rich analytics dashboard and non-essential Settings polish beyond essential recovery/safety UX.

Each optional capability requires its own approved plan because request direction, approval, replay, injection, audit, and recovery semantics differ from tool calls.

## Supported Deployment Contract

- Production data home has exactly one active mini-dsh host process.
- PM2 uses one `fork` instance; cluster/multi-worker mode against one data home is rejected.
- A durable workspace/data-home ownership lock with fencing epoch prevents concurrent writers and runtime owners; lock loss fences dispatch.
- Windows is a required release platform. Linux is a required release platform for protocol and process gates. macOS may run best-effort lifecycle cleanup but receives no hard tree-wide CPU/memory claim until a tested containment primitive exists.
- Hard resource enforcement is advertised only where a specific primitive is proven: Windows Job Object and Linux cgroup v2 with required delegation. Unsupported hosts reject hard-limit configuration or clearly use best-effort monitoring.
- The local auth profile is loopback/single-user. Non-loopback requires a separately configured authenticated TLS profile.

## Contracts to Preserve

- Public tool names remain `mcp__<server>__<tool>`.
- One global tool definition per public name remains registered; workspace-specific descriptors/schemas and runtime generation are resolved dynamically from immutable ambient workspace scope.
- Host `blockedTools`, server `allowedTools`, mode/child ceilings, hooks, exact-call approval, and `requiresUserInteraction` remain authoritative before execution.
- Manual repeat after `indeterminate` is a new invocation, receives a fresh current policy revision and approval, and never inherits the prior grant.
- `plans/260922-1037-modes-as-single-source/` owns permission migration. This plan supplies a compatibility fixture for policy-overlay and modes-only adapters.
- `plans/260921-1457-claude-style-subagents/` owns child lifecycle/identity. This plan supplies child/root indeterminate-repeat and approval-relay compatibility tests.
- MCP process ownership stays separate from Workbench terminal PTYs; only a versioned common host-shutdown interface may be shared.
- This plan owns MCP-specific Settings/transcript implementation and acceptance in Phases 9-10, while reusing the component/design contract from `plans/260911-1139-product-ui-standardization/`; it does not wait on that plan's stale metadata or duplicate its general shell work.

## Target Architecture

```text
Browser / CLI
  -> local control-plane auth (default deny, cookie+CSRF or scoped bearer)
  -> revisioned desired MCP config / encrypted credentials / mutation log
  -> data-home ownership lock + workspace runtime supervisor
       -> immutable generation + dynamic descriptor snapshot
       -> stdio process controller or Streamable HTTP transport
       -> connect/reconnect single-flight
  -> existing prepare/rewrite/mode/child/policy/approval pipeline
  -> agent's durable canonical tool/call record
  -> MCP execution coordinator
       -> synced dispatch_intent in <data>/workspaces/<id>/mcp/executions.jsonl
       -> one transport dispatch through explicit dispatch receipt contract
       -> success | error(tool|protocol|local diagnostic) | indeterminate | audit_fault
       -> synced terminal/late-evidence record
  -> authenticated SSE/UI projection
```

### Outcome model

```ts
type ToolOutcome = "success" | "error" | "indeterminate" | "audit_fault";
```

`audit_fault` represents a known remote outcome whose terminal execution evidence could not be durably persisted. It blocks further MCP dispatch until repaired. The conversational `tool/call` durability barrier and MCP execution journal remain separate authorities.

### Persistence model

- Extract or create a dedicated sequenced JSONL codec; do not cast MCP records through the session-specific `readEventLog` validator.
- Journal records include schema/canonicalization/digest-key versions, config/secret revisions, runtime generation, policy decision reference, and redacted diagnostics.
- Same-user tamper resistance is not claimed; this is crash-durable execution evidence protected by normal filesystem ACLs.
- Config/secrets/revocation changes use a durable mutation intent/commit protocol because independent atomic file replacements are not a multi-file transaction.
- Direct edits to `mcp.json`/secret metadata are not a live production API. They produce drift/fencing and must be imported through authenticated validation/migration.

## Phase Roadmap

| # | Phase | Priority | Dependencies | Status |
|---|---|---|---|---|
| 1 | [Threat Model and Compatibility Baseline](./phase-01-start.md) | P1 | None | Done |
| 2 | [Local Control-Plane Authentication](./phase-02-local-control-plane-authentication.md) | P1 | 1 | Done |
| 3 | [Config Compatibility and Migration Kernel](./phase-03-config-compatibility-and-migration-kernel.md) | P1 | 1, 2 | Done |
| 4 | [Safe Tool Calls and Audit Integrity](./phase-04-safe-tool-calls-and-audit-integrity.md) | P1 | 1, 3 | Done |
| 5 | [Protocol and Transport Hardening](./phase-05-protocol-and-transport-hardening.md) | P1 | 1, 4 | In progress |
| 6 | [Process Ownership and Resource Policy](./phase-06-process-ownership-and-resource-policy.md) | P1 | 3, 5 | In progress |
| 7 | [Desired-State Runtime Reconciliation](./phase-07-desired-state-runtime-reconciliation.md) | P1 | 3-6 | In progress |
| 8 | [Managed MCP OAuth Profile](./phase-08-managed-mcp-oauth-profile.md) | P1 | 2, 5, 7 | In progress |
| 9 | [MCP Settings and Diagnostics](./phase-09-mcp-settings-and-diagnostics.md) | P1 | 2, 7, 8 | In progress |
| 10 | [Conformance and Full-Stack Verification](./phase-10-conformance-and-full-stack-verification.md) | P1 | 2-9 | Blocked |
| 11 | [Rollout, Documentation, and Signoff](./phase-11-rollout-documentation-and-signoff.md) | P1 | 10 | Blocked |

## Cross-Plan Compatibility Gates

- **Modes:** fixture covers exact MCP key, `mcp__server__*`, global `*`, default, force-ask, host block, server allowlist, child ceiling, and yolo preserving deny under both policy adapters. Final release cannot land across an unresolved merge order.
- **Subagents:** child indeterminate call stays scoped, parent sees duplicate warning, repeat gets fresh approval/current identity, ceiling still denies forbidden tools, and no route replays the original invocation.
- **Terminal:** paired loopback user succeeds; unauthenticated/foreign-origin fails; non-loopback remains denied; MCP lifecycle never disposes terminal PTYs; host shutdown independently reaps both namespaces.
- **Product UI:** Phases 9-10 directly own MCP-specific component behavior, styling, accessibility, 200% zoom, screen-reader, long-list, and screenshot evidence while reusing the existing product design contract; no external plan-status blocker remains.
- **G5 base:** Phase 11 publishes a supersession table mapping previous retry, audit, environment, process, OAuth, fixtures, metrics, auth, and migration claims to retained/strengthened/deprecated/deferred.

## Global Verification

```bash
npm run typecheck
npm test
npm run build:web
npm run test:browser
npm run test:browser:mcp
```

Phase 10 creates explicit Windows and Linux CI/runner jobs. Hermetic runs pass both a temporary data directory and temporary provider config path and audit the real user files afterward.

## Production Success Criteria

- [ ] mini-dsh issues at most one automatic application-level `tools/call` dispatch per invocation; redirects, re-auth, reconnect, and recovery never hide a second dispatch.
- [ ] Any ambiguous post-dispatch failure is `indeterminate`; a repeat is a fresh invocation with current approval.
- [ ] Every possible dispatch has a synced intent record, one proven writer, and idempotent crash recovery.
- [ ] Unauthenticated REST/SSE/upgrade requests fail by default; logout/revocation fences streams and approvals.
- [ ] Legacy config is readable before defaults change; omitted-enabled entries are quarantined and unsafe downgrade is refused.
- [ ] Normal HTTP and OAuth use one bounded outbound network policy with redirect/credential/SSRF protection.
- [ ] Config/secret mutation acknowledgment establishes a linearization point after which no new dispatch uses the old generation; in-flight and remote-revocation limits are reported truthfully.
- [ ] Stdio receives no unrelated ambient secrets and activation authorizes a canonical executable path with an explicit no-sandbox warning.
- [ ] Hard process/resource claims are limited to tested platform primitives; unsupported platforms do not overclaim containment.
- [ ] Managed OAuth works for the documented compatibility profile, with crash-safe refresh rotation and local-first revocation tombstones.
- [ ] Essential UI states survive refresh/restart and distinguish failure, auth-required, stale, indeterminate, and audit-fault.
- [ ] Real browser-to-web-to-MCP stdio and HTTP/OAuth flows pass without API interception.
- [ ] Quantified soak, ownership, ENOSPC/corruption, restart, migration, rollback-floor, Windows, and Linux gates pass with retained CI artifacts.
- [ ] No release document claims protection from same-user malware or universal MCP/provider/platform support.

## Release Claim

Production support is limited to the tested `2025-06-18` protocol matrix, stdio and Streamable HTTP tool execution, the declared single-owner loopback deployment profile, and the explicitly validated OAuth compatibility profile. Resources, prompts, roots, sampling, legacy HTTP+SSE, marketplace distribution, untested OAuth providers, and unsupported hard-containment platforms are not included.

<!-- slug: mcp-production-completion -->

Phase 10 and 11 stay blocked in this workspace. A 24-hour canary, a named human release approver, Windows Job Object proof, Linux cgroup proof, and cross-platform CI artifacts are not things this repository run can honestly complete.
