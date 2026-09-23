---
title: "Phase 5: Web UI for grants"
status: todo
priority: P2
effort: "1d"
dependencies: [2, 3]
---

# Phase 5: Web UI for grants

## Overview
Expose grants to the user: project-level additional folders in Settings → Projects, session folders in the
composer, and scope warning + session-allow in the approval card.

## Requirements
- Functional:
  - **ProjectsPanel** (`web/components/settings/ProjectsPanel.tsx`): per project an "Additional folders" list; add via picker of other workspace projects or `FolderPickerModal` (arbitrary path); per row access toggle `Read only / Read & write`; remove; badges "missing" (dangling project ref) / "invalid" (fails validation now). Server validation errors shown inline.
  - **Composer**: compact chip "+N folders"; popover lists effective grants (project ones read-only here, session ones removable) and "Add folder…" (FolderPickerModal → `PUT /api/workspaces/:id/sessions/:sid/grants` with `expectedRevision`; on 409 refetch and retry once). Hidden for child sessions.
  - **Approval card** (`web/components/chat/ApprovalBar.tsx`): show `scopeWarning` like `guardWarning`; buttons `Allow once` / `Allow <proposedGrant> for this session` (exact folder in label; only when `proposedGrant` present and session is root) / `Deny`. Update the card copy that says answers apply "to this request only" (`ApprovalBar.tsx:102-104`) when the session option is used.
  - Live updates: `session/grants` events via the existing session stream → `useSessionStream` state.
- Non-functional: follow `docs/design-guidelines.md` + settings-kit; keyboard accessible; no new dependency.

## Related Code Files
- Modify: `web/components/settings/ProjectsPanel.tsx`, `web/components/composer/Composer.tsx`, `web/components/chat/ApprovalBar.tsx`, `web/hooks/useSessionStream.ts`, `web/lib/api.ts`, `web/lib/types.ts`, `web/styles/app.css`
- Create: `web/components/composer/SessionFoldersChip.tsx`, `web/components/composer/session-folders.mounted.spec.tsx`, `web/components/settings/project-folders.spec.tsx`, `web/components/chat/approval-scope.spec.tsx`

## Implementation Steps
1. API client + types (Phase 2/3 contracts).
2. ProjectsPanel additional folders section.
3. SessionFoldersChip + composer integration.
4. Approval card warning + session button (POST `scope: 'session'`).
5. Specs: add/remove project folder PATCH; chip add PUT with revision + renders grant from stream; approval card shows exact folder, session button posts scope, no session button for child/invalid proposal.
6. `npm run build:web` + `pm2 restart mini-dsh`, verify live.

## Success Criteria
- [x] Specs green; live check: add folder → agent (told via context) reads file there without approval; out-of-grant → card shows warning, session allow works; reload keeps the card.

## Risk Assessment
- Composer crowding; if chip hurts layout, move list into existing project menu. Signal: screenshot review.
