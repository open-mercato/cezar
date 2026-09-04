# Coarse Cezar Cockpit Facade Design

## Purpose

Expose the already-working Cezar cockpit as a small publishable React API and mount it natively in the Mercato sandbox without an iframe. The public library is a facade over the complete existing application composition; it is not a request to migrate or publish every feature component independently.

The implementation starts from `3625a074`, the last lean milestone containing the compiled API client, isolated provider runtime, and scoped stylesheet machinery before the feature-by-feature expansion. The existing expansion branch remains untouched as reference.

## Decision

Publish a coarse `CezarCockpit` component from `@open-mercato/cezar-react`. Its private implementation reuses the existing `packages/web` app shell, route tree, screens, controllers, dialogs, Git views, GitHub workspace, settings, task creation, and task sessions as one composition.

Only the integration boundary is public:

- client and query runtime;
- authentication renewal and error callbacks;
- embedded versus standalone routing;
- initial/current cockpit location;
- appearance and availability;
- root sizing and portal ownership;
- the scoped stylesheet.

All underlying route and feature components remain private implementation details. They may be refactored later without changing the facade.

## Approaches considered

### 1. Bundle the existing web composition behind the React facade — selected

`packages/react` owns the public wrapper and package exports. A deliberate private build edge includes the existing web composition in the cockpit bundle. The web route tree remains the feature implementation, and only React and React DOM remain peer externals.

This produces the smallest behavioral change, immediately retains the complete cockpit, and gives consumers one stable package entry.

### 2. Extract a new private cockpit workspace package

Move the route tree and shell wholesale into a new internal package consumed by both web and React. This gives a cleaner source dependency graph but creates another package, manifest, build, and migration before the embed can be validated. It is deferred unless the direct private build edge proves technically unworkable.

### 3. Continue feature-by-feature ownership migration — rejected

This creates many public components and duplicates already-working application composition. It is unnecessary for the desired coarse component API and caused the discarded large change set.

## Public API

The stable public surface is intentionally small:

```tsx
import type { QueryClient } from '@tanstack/react-query'
import type { ApiError, CezarClient } from '@open-mercato/cezar-api-client'
export type CezarCockpitRouting =
  | { mode: 'browser' }
  | {
      mode: 'memory'
      initialPath?: string
      path?: string
      onPathChange?: (path: string) => void
    }

export interface CezarCockpitProps {
  client: CezarClient
  queryClient?: QueryClient
  routing?: CezarCockpitRouting
  onAuthRequired?: (error: ApiError) => void | Promise<void>
  onError?: (error: ApiError) => void
  className?: string
}
```

The package continues to export `CezarProvider` for advanced composition, but consumers do not need to assemble the cockpit feature by feature. `TaskComposer` and `TaskSession` are not prerequisites for the facade and are not expanded as part of this lean change.

Project selection and appearance are deliberately not duplicated as facade props. The complete
route tree owns project scope, and the existing Appearance settings own theme, accent, density,
and reading width. Advanced hosts that compose their own surfaces may continue configuring those
values through `CezarProvider`; the standard cockpit has one owner for each value.

## Internal application composition

The current web `App` is split once at its natural outer boundary:

- `CezarCockpitImplementation` contains the existing global events, notifications, theme/appearance, provider bridge, reference registry, app shell, complete route tree, and toaster.
- `StandaloneCezarApp` supplies the browser router and the standalone-created runtime.
- public `CezarCockpit` supplies an injected runtime and either browser or memory routing.

No route, Git screen, GitHub screen, setting, composer, or session controller is rewritten for the package. The standalone app and package facade render the same implementation.

The private implementation may import package-core provider utilities. The React library build treats that self-edge as source during bundling so the published cockpit entry has no runtime dependency on private web source paths.

## Routing

Standalone Cezar keeps `BrowserRouter` and all current deep links.

The sandbox uses memory routing so cockpit navigation cannot take ownership of the Next.js host URL or reload the outer workspace. The memory adapter supports:

- `initialPath` for initial selection;
- optional controlled `path`;
- `onPathChange` for sandbox URL synchronization;
- the complete existing internal route table.

Browser and memory modes share the same route components. The facade does not translate individual features into a new navigation system.

## Runtime and authentication

The sandbox retains the runtime already implemented in `cezar-workspace-runtime.tsx`:

- `createCezarClient({ baseUrl: authority, credentials: 'include' })`;
- one query client per sandbox and Cezar authority;
- one bounded `401` renewal cycle;
- active Cezar query invalidation after renewal;
- re-arming after a successful Cezar query or a newer apps-access result;
- cache and renewal cleanup on unmount or authority change.

`CezarCockpit` receives the client, query client, auth callback, and error callback. It does not create a competing sandbox runtime, query cache, or event stream.

The lean sandbox integration mounts the cockpit only while the sandbox is running and Cezar access
is available. It therefore does not add a facade-level read-only mode whose write semantics the
existing private controllers do not implement. Paused, transitioning, and unavailable sandbox
states remain host-owned placeholders outside the cockpit.

Standalone Cezar may continue creating these values in its outer app wrapper.

## CSS, appearance, layout, and portals

Consumers import one stylesheet:

```ts
import '@open-mercato/cezar-react/styles.css'
```

The package stylesheet is compiled against both the public facade and the private web implementation source so Tailwind retains every class used by the complete cockpit. The existing post-build scoping pass then:

- scopes selectors below `.cezar-root`;
- namespaces custom properties and keyframes;
- namespaces non-generic fonts;
- rejects unsafe document-global selectors.

The existing provider configuration remains authoritative:

- theme, accent, density, and width selected by the existing Appearance settings become
  `.cezar-root` data attributes;
- all visual tokens are CSS variables owned by `.cezar-root`;
- the cockpit root uses `size-full min-h-0 min-w-0` in the sandbox;
- dialogs, sheets, menus, tooltips, and toasts render into a portal inside the Cezar root;
- hiding or inerting the sandbox panel also hides and inerts its overlays;
- neither host styles nor Cezar styles escape their boundary.

`CezarCockpit` owns or adopts the root element required by the private application/provider bridge. Consumers are not required to locate a global DOM node.

## Packaging

`@open-mercato/cezar-react` adds a `./cockpit` export and may also re-export `CezarCockpit` from the root entry. The tarball includes:

- the facade entry and its private route chunks;
- the complete scoped stylesheet and font assets;
- type declarations containing only public package paths;
- package metadata and peer/runtime dependencies.

React and React DOM remain peers. The cockpit's existing third-party feature dependencies may ship as bundled private chunks initially; they are not new public APIs.

The packed-consumer gate installs the contract, API client, and React tarballs into a cold fixture, imports `CezarCockpit`, type-checks it, builds it, and asserts that no source path under `packages/web` appears in emitted declarations or runtime imports.

## Mercato sandbox cutover

The portal keeps `CezarWorkspaceRuntime` and the current native-panel lifecycle. `CezarNativePanel` stops manually composing `TaskList` plus `TaskSession` and instead renders `CezarCockpit` with:

- the runtime client/query client/auth callback;
- memory routing;
- the existing scoped stylesheet;
- full-height sizing;
- sandbox availability and navigation synchronization.

`CezarWorkspaceRuntime` continues owning the client, query client, renewal controller, and selected location. Its current `CezarWorkspacePanelProvider` wrapper is removed or reduced to a value adapter so that `CezarCockpit` is the sole provider/root/portal owner; the sandbox must not nest two Cezar providers or open two live runtimes.

The “Open full Cezar for other features” limitation is removed because the native panel contains the complete cockpit. An external-open action may remain as an optional convenience, not a functional escape hatch.

The panel remains mounted across Web, Editor, terminal, logs, and split-view changes. A stable
host-owned mount element may move between the preview and dock slots without remounting the React
cockpit. Exactly one cockpit subtree and one workspace subscription exist, and no Cezar iframe is
created.

## Error handling

- Package compatibility and API errors render inside the cockpit boundary.
- A Cezar failure does not replace or crash the surrounding workspace.
- Authentication renewal remains host-owned and bounded.
- Invalid Cezar access URLs remain rejected before creating a client.
- Memory-router errors remain inside the cockpit; they never navigate the outer portal.
- The existing standalone error and unavailable screens are reused.

## Verification and success criteria

The change is complete when:

1. A cold consumer imports and builds `CezarCockpit` from packed tarballs.
2. Standalone Cezar still passes its existing route and feature tests through the shared implementation.
3. The sandbox mounts the full cockpit without an iframe.
4. A user creates a task, sees it in the task list, opens its session, and navigates the existing cockpit areas from the embedded panel.
5. Git, GitHub, settings, automations, skills, inbox, workflows, task Git tabs, and repository Git render through the existing private route tree.
6. The scoped stylesheet and root-owned portal are visually verified in Chrome.
7. Switching workspace tabs or split layouts preserves the mounted cockpit and does not duplicate streams, caches, or portals.
8. The lean branch stays independent of the feature-by-feature expansion branch.

## Non-goals

- Publishing every route or controller as an independent component.
- Rewriting existing features to remove React Router before the first facade release.
- Supporting multiple independently routed cockpit instances in one sandbox panel.
- Adding feature-wide read-only semantics to the existing private controllers.
- Removing the standalone Cezar application.
- Publishing to npm before local tarball installation and sandbox browser validation succeed.
