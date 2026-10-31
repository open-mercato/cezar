# Explain the folder browser root boundary (#1688)

## TLDR

People with repositories outside the default home browse root cannot discover why Up disappears. Add a concise boundary explanation and a direct link to Settings → Projects → Default browse folder. Preserve the server's configured containment boundary.

Source issue: https://github.com/open-mercato/cezar/issues/1688

## Problem and evidence

The issue and maintainer triage describe Open local folder starting at the home directory and silently hiding Up. `folder-browser.tsx` renders Up only for a non-null server parent; `fs-browse.ts` deliberately returns null at the configured root. The existing setting is at `/settings/global/projects`.

## Resolved assumptions (autonomous defaults)

| Question | Chosen answer | Reason |
| --- | --- | --- |
| Q1. Shared picker or Add project only? | Shared FolderBrowser. | Both Add project and Add agent account use the same server boundary and setting; avoids a second interpretation of root. |
| Q2. Route navigation and open dialogs? | A normal anchor to the existing global Settings page. | A full navigation dismisses dialogs owned above the route as well as route-owned dialogs, needs no new caller callback, and works over LAN. |

No high-stakes assumptions. No defaults, permissions or public contracts change.

## Proposed solution and architecture

Add a small explanatory paragraph between the resolved breadcrumb and folder listing. Render it only when a successful listing exists, no error is active, and `listing.data.parent === null`. Read the root path from the server's canonical `listing.data.path`, never infer it from the request sentinel. The hint therefore returns after Up reaches the root by its absolute path.

Proposed copy: “This is the browse root. To browse elsewhere, change Default browse folder in Settings → Projects.” The breadcrumb immediately above identifies the configured root. Link the setting name and location to `/settings/global/projects` using an ordinary anchor, following the existing global destination. A document navigation closes any open picker overlay without a shared caller change.

The shared picker, API response and `useFsBrowse` query stay otherwise unchanged. No new entities, API shapes, environment variables or dependencies. Server containment and symlink checks remain authoritative.

## UI/UX and acceptance criteria

1. At a successful root listing, show a readable explanation adjacent to the canonical path and a keyboard-accessible link naming Default browse folder and Settings → Projects.
2. Following the link from either picker reaches the existing global Projects settings and dismisses the picker. The existing Default browse folder field is the first setting on that page.
3. Below the root, show Up exactly as before and hide the boundary hint. Selecting and entering folders are unchanged.
4. Pending initial loading and errors do not show a false root explanation. Existing error/back/retry and truncation messages remain.
5. Empty root listings still show the explanation and existing empty-folder guidance. Long Windows and POSIX paths stay in the truncated breadcrumb with a title; the new copy wraps at narrow widths.

Mockups: text-only design; no task-specific test environment/browser was available at spec publication. Implementation must attach real browser evidence separately.

## Research

[VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) makes a restriction visible with a banner and a management link. Apply that general discoverability pattern here with a small inline note; a warning banner or a new configuration flow would be excessive for this intentional boundary. This is an inferred design analogy, not evidence of cezar behavior.

## Failure cases, compatibility and risk

A failed browse retains its existing server error. A missing listing is loading, not proof of reaching the root. Cached data accompanying an error must not show a root explanation. Links use the same origin so remote cockpit authentication and deployment origin are preserved. The anchor reloads the cockpit intentionally to dismiss shared overlays; no picker state is persisted or silently saved.

Low risk: additive UI guidance only. Server navigation semantics, request shape, containment and symlink escape protection do not change. Revert the component change to remove the guidance. No migration or release backport is required for this new enhancement.

## Implementation Plan

### Phase 1: Boundary explanation

1. Add the successful-root hint and Settings link in `packages/web/src/components/folder-browser.tsx`, preserving every existing navigation and error control.
2. Add `folder-browser.test.tsx` covering resolved root, return by absolute path, nested Up, selection, loading, error (including cached root data), empty roots, long paths and link destination.

### Phase 2: Verification and review

3. Demonstrate new hint tests fail on the original component. Run the repository's complete configured validation gate and review the scoped diff.
4. Run independent review and real-browser QA for root/nested/settings, empty/error/loading and narrow viewport. Attach honest evidence and leave human QA required.
