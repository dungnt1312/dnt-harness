# MCP production boundaries

Status: accepted for the production-completion milestone (2026-09-22).
Scope: the contracts phase 1 freezes. Later phases implement them; they do not rename them.

## Protocol

This release negotiates MCP `2025-06-18` only. Any other version fails as `unsupported_protocol_version`. Adding a version requires a reviewed fixture, a deprecation note for the version it replaces, and an explicit diagnostic mapping. Resources, prompts, roots, sampling, and legacy HTTP+SSE are out of this milestone.

## Outcomes

A tool result is `success`, `error`, `indeterminate`, or `audit_fault`.

- `indeterminate` means the request may have executed remotely. The client does not retry it. A person may try again; that attempt is a new invocation with a fresh approval and a new invocation id.
- `audit_fault` means the remote outcome is known but its terminal evidence could not be persisted. Further MCP dispatch stays blocked until that evidence is repaired.
- Non-MCP tools omit `outcome` and `invocationId`. Legacy logs stay readable.

`failed`, `cancelled`, `connected`, and `revoked` are not outcome names. Cancellation before send is `not_dispatched`. Cancellation after send is `possibly_dispatched`, which surfaces as `indeterminate`.

## Dispatch receipt

A transport reports `not_dispatched` or `possibly_dispatched` for one `tools/call` attempt. `possibly_dispatched` covers an accepted or buffered write, an HTTP fetch that has started, a followed redirect, cancellation after send, reconnect, re-auth, process death after the write, and a lost response. Exactly-once remote effects are not claimed.

## Server metadata

Tool names, descriptions, schemas, and annotations from a server are untrusted model context. They are provenance-labeled `mcp-server`, length-bounded, and never parsed as host policy. Annotations, including `readOnlyHint`, never reduce an approval requirement.

## What this milestone replaces

Earlier MCP behavior that retried `tools/call` three times is withdrawn. A lost response stays `indeterminate`. Saving a server no longer means it is running. A legacy `oauth` block is an external token until a managed authorization-code session exists. Hard resource numbers are refused unless a tested Job Object or cgroup is actually applied; this build applies neither. A 24-hour canary and a named release signature are still required before a production claim.

## Deployment

One data home has one active host process. PM2 runs a single `fork` instance; cluster mode against one data home is rejected. The minimum safe rollback floor is binary `0.1.0` with config schema `1`: this release can still read that schema, and it refuses a downgrade that would drop a newer schema it does not understand.

The local auth profile is loopback, single user. A non-loopback bind requires a separately configured authenticated TLS profile.

## What this does not protect against

Filesystem encryption and ACLs do not protect against code running as the same user. Local authentication does not protect against same-origin XSS or a browser extension on the operator's profile. Minimizing a subprocess environment is not a sandbox. Hard process containment is not claimed until a tested platform primitive exists (phase 6).

## Control plane

Every privileged REST, SSE, and terminal route is listed in `src/harness/mcp/route-inventory.ts` with its credential and expected denial. Phase 2 enforces default-deny authentication. `/api/meta` and static assets stay public behind the existing host allow-list. There is no WebSocket upgrade today; terminal streams are SSE.
