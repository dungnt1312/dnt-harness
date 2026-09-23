---
phase: 9
title: "MCP Settings and Diagnostics"
status: in-progress
priority: P1
effort: "5-7 days"
dependencies: [2, 7, 8]
---

# Phase 9: MCP Settings and Diagnostics

## Overview

Deliver the essential operator UX for safe configuration, activation, runtime diagnosis, OAuth recovery, and ambiguous outcomes. Extend the existing `McpPanel`/settings-kit/ToolCard/transcript patterns; defer rich analytics and non-essential polish.

## Requirements

- Save never activates; activation is a separate explicit operation.
- Essential supported fields are editable: env, pass-through names, headers, lifetime/limits, bearer/external token refs, managed OAuth.
- Activation and temporary connection test both disclose code/network execution risk and use the same confirmation/policy path.
- Durable statuses remain accurate after refresh/restart.
- Discovered/exposed tools and allowlist mismatches are visible.
- `indeterminate`/`audit_fault` render in transcript with no unsafe generic retry copy.
- Stale revision never silently overwrites; safe reload is P1, rich merge UI is optional.
- This phase owns MCP-specific visual/accessibility acceptance while reusing the design/component contract from `plans/260911-1139-product-ui-standardization/`; no external plan status blocks completion.

## Architecture

Backend/API exposes bounded diagnostics: revisions, status/error/attempt/handshake/protocol, breaker/retry/auth/audit/containment, discovered/exposed tools, and unresolved invocation count. Remote descriptions are bounded and labeled server-provided/untrusted.

Completed tool outcomes project through `web/lib/project.ts` and `MessageParts.tsx`. A dedicated indeterminate notice initiates a new call through normal policy/approval; `ApprovalBar` remains pre-dispatch approval UI.

## Related Code Files

- Modify: `src/web/server.ts`
- Modify: `web/lib/api.ts`
- Modify: `web/lib/types.ts`
- Modify: `web/lib/project.ts`
- Modify: `web/components/chat/MessageParts.tsx`
- Modify: `web/components/chat/Transcript.tsx`
- Modify: `web/App.tsx`
- Create: `web/components/chat/IndeterminateCallNotice.tsx`
- Modify: `web/components/settings/McpPanel.tsx`
- Modify: `web/components/settings/SecretsPanel.tsx`
- Modify: existing settings/product/artifact tests
- Modify: fixture browser workflow tests
- Reference/reuse: `plans/260911-1139-product-ui-standardization/design-contract.md` and existing UI primitives; this phase modifies and accepts MCP-specific files directly

## Implementation Steps

1. Extend authenticated read APIs with bounded diagnostics and ETag/revision. No raw credentials or unbounded metadata.
2. Extend existing MCP form only for missing fields: structured env/passEnv, headers, max lifetime/new limits, auth modes, managed OAuth, revision/conflict state. Preserve safe stored-field merge during transition.
3. Remove editable Enabled switch semantics. Save disabled desired config; authenticated Activate operation follows preview.
4. Activation preview shows canonical executable/URL, args, workspace, env/pass-through names, secret refs, destination/resource, limits/containment level, and explicit arbitrary-code/network/no-sandbox warning.
5. Rename to “Run temporary connection test.” Require activation-grade preview/confirmation, rate-limit/audit, run through process/network/limits/journal, never call tools, clean bounded session/process, and do not publish as live ready state.
6. Show disabled/reconciling/ready/failed/breaker/auth-required/missing-secret/stale/audit-fault/containment-unavailable states with last error/attempt/retry and safe actions.
7. Show discovered/exposed/filtered/blocked tools and unmatched allowlist entries. Server annotations never imply reduced approval.
8. Add managed OAuth authorize/cancel/re-authorize/revoke flow and truthful remote-revocation status.
9. Render indeterminate and audit-fault through transcript/tool card. Replace generic “nothing executed, retry safe” for MCP ambiguity. Manual repeat shows duplicate-effect warning and creates fresh approval.
10. Handle 409 with clear reload/compare summary; rich three-way merge is follow-up unless required by usability testing.
11. Keep metrics collection needed for Phase 10 gates, but defer p50/p95 dashboard to follow-up.
12. Implementers complete keyboard, screen-reader, focus, responsive, reduced motion, 200% zoom, long-list, and screenshot gates for MCP essential flows using the existing product design contract and accepted visual gate.

## Success Criteria

- [x] Users can configure essential supported MCP fields without editing files.
- [x] Save cannot start a server; activation/test disclose and confirm trust boundary.
- [x] Temporary connection test is audited/bounded and never becomes live state or calls tools.
- [ ] Durable failure/auth/stale/audit/containment states survive refresh/restart. The list renders stale, audit, and containment from the server. A restart browser pass is still open.
- [x] Discovered/exposed tools and allowlist issues are understandable.
- [ ] OAuth recovery/revoke status is accurate and token-safe. Not shown as its own recovery control.
- [x] Indeterminate/audit-fault are distinct from normal errors; no silent retry exists.
- [x] 409 cannot silently discard concurrent edits.
- [ ] Essential flows pass fresh component/browser/a11y/zoom/screenshot evidence from product UI integration owner. Component tests cover save, enable confirm, and the 409 keep. Browser, zoom, and screenshot gates are still open.
- [ ] No credentials or unbounded remote metadata appear in API/DOM/log snapshots. Not scanned.

## Risk Assessment

Avoid turning this into a full Settings redesign. This phase and Phase 10 own MCP-specific behavior, presentation, accessibility, and visual acceptance while reusing existing product UI primitives/design contract. Rich dashboards, comprehensive offline autocomplete, and advanced conflict merge are deferred unless essential recovery testing proves them necessary.
