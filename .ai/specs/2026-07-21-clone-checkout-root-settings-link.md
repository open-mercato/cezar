# Clone dialog checkout-root settings link

Status: implemented · Date: 2026-07-21 · Issue: #561 · Extends: spec 2026-07-20-multi-project-workspace

## Problem

The **Add project → Clone from GitHub** dialog previews its destination under the
configured checkout root, but it does not provide a direct way to edit that root. A
user who notices the wrong directory must close the dialog, discover Global settings,
open Projects, and then find the checkout-root field.

Issue #561 originally also reported that a saved root stayed stale in the clone dialog.
That independently deployable cache defect was split to #567. This specification covers
only the settings shortcut.

## Goals

- Put a compact settings affordance beside the resolved clone target.
- Navigate directly to **Global settings → Projects**, where the checkout root is edited.
- Match the cockpit's existing icon-button language and accessibility behavior.
- Keep the change additive and local to the clone dialog.

## Non-goals

- Editing or saving the checkout root inside the clone dialog.
- Changing workspace APIs, query-cache behavior, or checkout validation.
- Preserving partially entered clone form data after navigating to settings.
- Adding configuration, environment variables, redirects, or new routes.

## User experience

The target preview row keeps the resolved `<projectsDir>/<name>` path and adds a small
cog icon at its right edge. The icon is a plain React Router link to
`/settings/global/projects`, because Global settings are intentionally outside every
project scope. It uses the existing ghost icon-button styling.

The link has the accessible name and native tooltip **Edit checkout root**. Keyboard
focus uses the shared button focus treatment. While a checkout is pending, the control
is disabled so navigation cannot abandon a clone whose dialog currently prevents close.

On narrow viewports the path truncates before the fixed-size icon; the full path remains
available through the preview's existing `title` attribute.

## Requirements and acceptance criteria

1. The clone target row renders a visible settings/cog icon whenever the dialog is open.
2. The control links to exactly `/settings/global/projects`; it must not receive a
   `/p/:projectId` prefix.
3. The control exposes `aria-label="Edit checkout root"` and
   `title="Edit checkout root"`.
4. The target preview remains readable and truncates without pushing the icon out of the
   dialog.
5. The control cannot navigate while `useCheckoutProject()` is pending.
6. Existing clone submission, progress, error, close, and post-clone navigation behavior
   remains unchanged.
7. Unit coverage asserts the destination, accessible name, and pending disabled state.
8. The repository's configured validation gate passes.

## Compatibility, security, and degradation

This is an additive client-side navigation affordance. It changes no protected HTTP,
route, CLI, event, schema, configuration, persistence, or package surface. It introduces
no new input or data access and inherits the existing Global settings route's behavior.
If project data fails to load, the link still reaches the place where the root is managed.

## Implementation Plan

### Phase 1 — Clone-dialog shortcut

1.1 Update `web/app/src/components/clone-project-dialog.tsx`: import the plain router
    `Link` and the existing Lucide settings icon, make the target preview a flexible row,
    and add the accessible ghost icon link to `/settings/global/projects`.

1.2 Preserve pending-state semantics by rendering the same icon control disabled while
    checkout is pending, without creating an active link.

### Phase 2 — Verification

2.1 Extend `web/app/src/components/clone-project-dialog.test.tsx` to assert the shortcut's
    exact href and accessible name, then hold checkout pending and assert the control is
    disabled and cannot navigate.

2.2 Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, and
    `npm run test:package` in order. Manually verify the clone dialog at desktop and
    mobile widths, keyboard focus, navigation to Global settings → Projects, and target
    truncation.

## Open Questions

None. The route, component primitives, pending behavior, and scope split are all resolved
by existing cockpit conventions and the approved #561/#567 issue split.
