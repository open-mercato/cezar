# Coarse Cezar Cockpit Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one native `CezarCockpit` React component that renders the complete existing Cezar application without an iframe or feature-by-feature migration.

**Architecture:** Split the existing web `App` once at its outer composition boundary, bundle that private composition behind `@open-mercato/cezar-react/cockpit`, and keep every route, screen, controller, and dialog in `packages/web`. The facade owns an isolated root, browser-or-memory routing, the injected Cezar client/query cache, normalized host error callbacks, and the existing scoped stylesheet/portal boundary.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, Vite 8 library mode, Tailwind CSS 4, Vitest, TypeScript 7, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-24-coarse-cezar-cockpit-facade-design.md`

## Global Constraints

- Start from commit `3625a074`; do not merge or cherry-pick the feature-by-feature expansion branch.
- `CezarCockpit` is the only new coarse public UI surface; existing routes and feature controllers remain private in `packages/web`.
- The component renders no iframe and must not navigate the host URL in memory-routing mode.
- The complete web route table remains the one route table for standalone and embedded Cezar.
- Exactly one injected `QueryClient` and one workspace event stream serve a cockpit instance.
- The supported embedded transport for this milestone is `client.baseUrl` with browser credentials; custom client transports are not silently claimed by the private legacy web boundary.
- Project scope and Appearance settings remain owned by the existing route tree and cockpit settings, not duplicated as facade props.
- Consumers import one precompiled stylesheet; no Tailwind setup is required.
- Every emitted selector is scoped beneath `.cezar-root`; custom properties, keyframes, and non-generic fonts remain namespaced.
- All overlays render into the provider-owned portal below `.cezar-root`.
- React and React DOM remain peer dependencies; private web feature dependencies are bundled into cockpit chunks.
- Package modules must be safe to import without reading `window` or `document` at module evaluation time.
- Use Node 24 for all commands: `PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env`.
- Run Vitest through `npm test -- ...`, never `npx vitest`.
- Run the five repository gates once, in order, only after the coarse package milestone is complete.

---

### Task 1: Extract the complete private cockpit composition

**Files:**
- Create: `packages/web/src/cockpit-implementation.tsx`
- Create: `packages/web/src/cockpit-implementation.test.tsx`
- Modify: `packages/web/src/app.tsx`
- Modify: `packages/web/src/components/reference-cezar-provider.tsx`
- Modify: `packages/web/src/components/reference-cezar-provider.test.tsx`
- Modify: `packages/web/src/components/theme-provider.tsx`
- Modify: `packages/web/src/components/theme-provider.test.tsx`
- Modify: `packages/web/src/components/appearance-provider.tsx`
- Modify: `packages/web/src/routes/settings/settings.test.tsx`
- Modify: `packages/web/src/api/global-events.tsx`
- Modify: `packages/web/src/api/global-events.test.tsx`

**Interfaces:**
- Consumes: `CezarClient`, `QueryClient`, `AppRoutes`, `AppShellContainer`, `ReferenceCezarProvider`, and the existing global event/appearance/notification components.
- Produces:

```ts
export interface CezarCockpitImplementationProps {
  client: CezarClient
  queryClient: QueryClient
  rootElement: HTMLElement
  onAuthRequired?: (error: ApiError) => void | Promise<void>
  onError?: (error: ApiError) => void
  className?: string
}

export function CezarCockpitImplementation(
  props: CezarCockpitImplementationProps,
): React.JSX.Element
```

- `App` remains the standalone owner of client/query construction and browser routing, but renders the same `CezarCockpitImplementation` used by the package facade.

- [ ] **Step 1: Write the failing shared-composition tests**

Add tests which mount the private implementation inside `MemoryRouter` with a supplied client,
query client, root element, and a fake `EventSource`. Assert that the complete shell renders, `/new`
reaches the existing New Task screen, a task detail route reaches the existing session screen, only
one query client is observed, exactly one workspace event source opens, navigation does not reopen
it, and no `iframe` exists.

```tsx
render(
  <MemoryRouter initialEntries={['/p/project-a/new']}>
    <CezarCockpitImplementation
      client={client}
      queryClient={queryClient}
      rootElement={rootElement}
    />
  </MemoryRouter>,
  { container: rootElement },
)

expect(await screen.findByRole('heading', { name: /new task/i })).toBeVisible()
expect(document.querySelector('iframe')).toBeNull()
expect(rootElement.querySelectorAll('.cezar-root')).toHaveLength(0)
expect(rootElement.classList).toContain('cezar-root')
expect(eventSources).toHaveLength(1)
```

Extend the standalone `App` test coverage to prove it reaches the same implementation rather than a copied route composition.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project web packages/web/src/cockpit-implementation.test.tsx packages/web/src/components/reference-cezar-provider.test.tsx
```

Expected: FAIL because `cockpit-implementation.tsx` and the injected implementation boundary do not exist.

- [ ] **Step 3: Move the current `App` body without changing feature ownership**

Move this exact composition from `App` into `CezarCockpitImplementation`:

```tsx
<QueryClientProvider client={queryClient}>
  <GlobalEventsProvider>
    <RunNotifications />
    <ThemeProvider rootElement={rootElement}>
      <AppearanceProvider rootElement={rootElement}>
        <ReferenceCezarProvider
          client={client}
          queryClient={queryClient}
          rootElement={rootElement}
          onAuthRequired={onAuthRequired}
          onError={onError}
          className={className}
        >
          <LastLocationController />
          <ReferenceStatusRegistry>
            <AppShellContainer>
              <AppRoutes />
            </AppShellContainer>
          </ReferenceStatusRegistry>
          <Toaster />
        </ReferenceCezarProvider>
      </AppearanceProvider>
    </ThemeProvider>
  </GlobalEventsProvider>
</QueryClientProvider>
```

The outer `QueryClientProvider` is required by the existing global-events and Appearance
controllers that render above `ReferenceCezarProvider`. `CezarProvider` receives the exact same
`queryClient`, so both contexts reference one cache; no second query client is constructed. Change
standalone `App` to construct one client/query client, set the API base before child query effects,
wrap with `BrowserRouter`, and render `CezarCockpitImplementation`.

- [ ] **Step 4: Make appearance target the adopted Cezar root**

Add `rootElement?: HTMLElement` to `ThemeProvider` and `AppearanceProvider`, defaulting to `document.documentElement` inside effects for standalone tests. Stamp the supplied root when embedded:

```tsx
const target = rootElement ?? document.documentElement
React.useLayoutEffect(() => {
  applyResolvedTheme(target, resolvedTheme)
}, [target, resolvedTheme])
```

Pass the current resolved theme/accent/density/width through `ReferenceCezarProvider` into `CezarProvider`, so the adopted `.cezar-root` remains the single visual owner. Preserve the existing settings mutations and storage behavior.

- [ ] **Step 5: Normalize private query failures for host callbacks**

The existing web query functions throw their private `ApiError`; the public callback accepts the API-client `ApiError`. Subscribe to the dedicated query client's query/mutation caches in `CezarCockpitImplementation`, ignore successful events and already-public `['cezar', client.identity, ...]` entries, and normalize failures structurally:

```ts
function publicApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error
  if (!(error instanceof Error)) return null
  const status = typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : 0
  return new ApiError(status, 'cockpit', error.message, undefined, { cause: error })
}
```

Call `onAuthRequired` only for status `401` and `onError` once for each cache error transition. Add a test with a private 401 proving one normalized auth callback and one error callback.

- [ ] **Step 6: Resolve event URLs after the embedded base is configured**

Replace the module-evaluated `SSE_URL` constant with a call-time default:

```ts
export function useGlobalEvents(
  usage: UsageStore,
  url: string = apiPath('/workspace/events'),
): void
```

Add a regression proving a base URL installed before render produces `https://cezar.example/api/v1/workspace/events`, not the portal origin.

- [ ] **Step 7: Run focused web tests and typecheck**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project web packages/web/src/cockpit-implementation.test.tsx packages/web/src/components/reference-cezar-provider.test.tsx packages/web/src/components/theme-provider.test.tsx packages/web/src/routes/settings/settings.test.tsx packages/web/src/api/global-events.test.tsx
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run typecheck:web
```

Expected: all selected suites and web typecheck PASS.

- [ ] **Step 8: Commit the shared composition**

```bash
git add packages/web/src
git commit -m "refactor(web): expose private cockpit composition"
```

---

### Task 2: Add the public browser/memory routed `CezarCockpit`

**Files:**
- Create: `packages/react/src/cockpit.tsx`
- Create: `packages/react/src/cockpit-private.d.ts`
- Create: `packages/react/src/cockpit.test.tsx`
- Modify: `packages/react/src/index.ts`
- Modify: `packages/react/src/public-api.test.ts`
- Modify: `packages/react/vite.config.ts`
- Modify: `packages/react/vitest.config.ts`
- Modify: `packages/react/package.json`
- Modify: `packages/react/tsconfig.json`
- Modify: `packages/web/vite.config.ts`
- Modify: `packages/web/tsconfig.json`
- Modify: `packages/web/src/app.tsx`

**Interfaces:**
- Consumes: `CezarCockpitImplementation` from Task 1 through the build-only alias `#cezar-web-cockpit`.
- Produces:

```ts
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

export function CezarCockpit(props: CezarCockpitProps): React.JSX.Element
```

- Package exports: root re-export and `@open-mercato/cezar-react/cockpit`.

- [ ] **Step 1: Write the failing public contract and routing tests**

Cover:

```tsx
const routing = {
  mode: 'memory',
  initialPath: '/p/project-a/new',
  onPathChange,
} satisfies CezarCockpitRouting

render(<CezarCockpit client={client} queryClient={queryClient} routing={routing} />)

expect(await screen.findByRole('heading', { name: /new task/i })).toBeVisible()
expect(window.location.pathname).toBe('/host/sandbox')
expect(document.querySelector('iframe')).toBeNull()
```

Also test controlled `path` replacement, internal navigation reporting `pathname + search + hash`,
default memory routing, browser routing in standalone `App`, SSR-safe module import, one
`.cezar-root`, one provider portal, `size-full min-h-0 min-w-0` layout classes, and a thrown private
render being contained by a package-owned alert/retry fallback.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project react packages/react/src/cockpit.test.tsx packages/react/src/public-api.test.ts
```

Expected: FAIL because the cockpit entry and exports do not exist.

- [ ] **Step 3: Implement the owned root and routing adapters**

Use a ref-owned root and render the private implementation only after the root exists:

```tsx
export function CezarCockpit({ routing = { mode: 'memory' }, ...props }: CezarCockpitProps) {
  const [rootElement, setRootElement] = useState<HTMLDivElement | null>(null)
  const content = rootElement ? (
    <CezarErrorBoundary
      fallback={({ reset }) => (
        <div role="alert">
          <p>Could not display Cezar.</p>
          <button type="button" onClick={reset}>Try again</button>
        </div>
      )}
    >
      <CezarCockpitImplementation {...props} rootElement={rootElement} />
    </CezarErrorBoundary>
  ) : null

  return (
    <div
      ref={setRootElement}
      data-cezar-routing={routing.mode}
      className="size-full min-h-0 min-w-0"
    >
      {routing.mode === 'browser'
        ? <BrowserRouter>{content}</BrowserRouter>
        : <MemoryRouter initialEntries={[routing.path ?? routing.initialPath ?? '/']}>
            <MemoryPathBridge routing={routing} />
            {content}
          </MemoryRouter>}
    </div>
  )
}
```

`MemoryPathBridge` compares the complete current location to controlled `path`, uses `navigate(path, { replace: true })` only when different, and invokes `onPathChange` after internal navigation. It must never call `history.pushState`, `location.assign`, or `location.replace`.

- [ ] **Step 4: Add the private source build seam**

Declare `#cezar-web-cockpit` in `cockpit-private.d.ts` with only the implementation signature. In Vite/Vitest, alias it to `packages/web/src/cockpit-implementation.tsx`, alias `@/` to `packages/web/src`, and alias the React package self-import to `packages/react/src/index.ts`. Do not externalize `@open-mercato/cezar-web`; it must not appear in emitted JavaScript.

The standalone web resolver and TypeScript paths need the cockpit subpath before the root alias:

```ts
'@open-mercato/cezar-react/cockpit': resolve(packagesDir, 'react/src/cockpit.tsx'),
'@open-mercato/cezar-react/styles.css': resolve(packagesDir, 'react/src/styles/index.css'),
'@open-mercato/cezar-react': resolve(packagesDir, 'react/src/index.ts'),
```

```json
"@open-mercato/cezar-react/cockpit": ["../react/src/cockpit.tsx"],
"@open-mercato/cezar-react": ["../react/src/index.ts"]
```

Add `cockpit` to the React library inputs:

```ts
input: {
  index: resolve(packageDir, 'src/index.ts'),
  cockpit: resolve(packageDir, 'src/cockpit.tsx'),
  tasks: resolve(packageDir, 'src/tasks.ts'),
  session: resolve(packageDir, 'src/session.ts'),
  styles: resolve(packageDir, 'src/styles/index.css'),
}
```

Add the package export and root re-export:

```json
"./cockpit": {
  "types": "./dist/cockpit.d.ts",
  "import": "./dist/cockpit.js"
}
```

- [ ] **Step 5: Keep standalone Cezar on the same facade**

Change standalone `App` to render:

```tsx
<CezarCockpit
  client={cezarClient}
  queryClient={queryClient}
  routing={{ mode: 'browser' }}
/>
```

Keep API-base resolution in `main.tsx`; remove duplicate browser-router/provider composition from `App`.

- [ ] **Step 6: Run public, route, boundary, type, and build checks**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project react packages/react/src/cockpit.test.tsx packages/react/src/public-api.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project web packages/web/src/cockpit-implementation.test.tsx packages/web/src/routes.test.tsx
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run check:boundaries -w @open-mercato/cezar-react
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run typecheck:react
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run typecheck:web
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run build:react
```

Expected: all checks PASS; `dist/cockpit.js`, private route chunks, and `dist/cockpit.d.ts` exist; no emitted file imports a repository source path.

- [ ] **Step 7: Commit the public facade**

```bash
git add packages/react packages/web/src/app.tsx packages/web/tsconfig.json packages/web/vite.config.ts
git commit -m "feat(react): export complete cezar cockpit"
```

---

### Task 3: Compile the complete scoped CSS and contain every overlay

**Files:**
- Modify: `packages/react/src/styles/index.css`
- Modify: `packages/react/scripts/styles-source.test.ts`
- Modify: `packages/react/scripts/scope-css.test.ts`
- Modify: `packages/react/scripts/verify-css.test.ts`
- Modify: `packages/web/src/styles/index.css`
- Modify: `packages/web/src/components/ui/alert-dialog.tsx`
- Modify: `packages/web/src/components/ui/dialog.tsx`
- Modify: `packages/web/src/components/ui/dropdown-menu.tsx`
- Modify: `packages/web/src/components/ui/popover.tsx`
- Modify: `packages/web/src/components/ui/select.tsx`
- Modify: `packages/web/src/components/ui/sheet.tsx`
- Modify: `packages/web/src/components/ui/tooltip.tsx`
- Modify: `packages/web/src/components/zoomable-image.tsx`
- Create: `packages/web/src/components/ui/provider-portal.test.tsx`
- Modify: `packages/web/src/components/zoomable-image.test.tsx`

**Interfaces:**
- Consumes: `useCezarPortal()` from the existing public provider.
- Produces: one `dist/styles.css` containing every complete-cockpit class and font asset, with every portal below `[data-cezar-portal]`.

- [ ] **Step 1: Write CSS source and overlay ownership failures**

Add assertions that the source entry scans both packages:

```ts
expect(css).toContain('@source "../../../web/src/**/*.{ts,tsx}"')
expect(css).toContain('@source "../**/*.{ts,tsx}"')
```

Mount a dialog, dropdown, popover, select, sheet, tooltip, and image lightbox under `CezarProvider`; open each and assert:

```ts
const portal = screen.getByTestId('cezar-portal')
expect(within(portal).getByRole('dialog')).toBeVisible()
expect(document.body.querySelector(':scope > [data-radix-portal]')).toBeNull()
```

Add compiled-CSS assertions for representative full-cockpit utilities (`grid-cols-[264px_1fr]`, `bg-sidebar`, `text-soft-foreground`), scoped `@font-face` names, and absence of raw `html`, `body`, `:root`, `--tw-*`, and unnamespaced keyframes.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project react packages/react/scripts/styles-source.test.ts packages/react/scripts/scope-css.test.ts packages/react/scripts/verify-css.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project web packages/web/src/components/ui/provider-portal.test.tsx packages/web/src/components/zoomable-image.test.tsx
```

Expected: FAIL because web sources are not scanned and overlays target `document.body`.

- [ ] **Step 3: Make the package stylesheet own the full cockpit token sheet**

Use the existing web stylesheet as the single full token/theme source and add the React source scan:

```css
@layer theme, base, components, utilities;
@import "../../../web/src/styles/index.css";
@source "../**/*.{ts,tsx}";
@source "../../../web/src/**/*.{ts,tsx}";

.cezar-root[data-cezar-routing='memory'] [data-slot='app-shell'] {
  height: 100%;
  min-height: 0;
}
```

Keep the standalone web build importing the same web stylesheet. Extend its light/accent/density/width selectors so both the standalone document root and adopted `.cezar-root` data attributes activate the same tokens. Do not duplicate the token values in a second stylesheet.

- [ ] **Step 4: Route all web overlays into the provider portal**

In each Radix wrapper, use the provider container:

```tsx
const container = useCezarPortal()
return (
  <DialogPrimitive.Portal container={container ?? undefined} {...props} />
)
```

For `ZoomableImage`, replace `document.body` with `useCezarPortal()` and render the lightbox only when the portal element exists. Preserve keyboard dismissal and the existing same-origin image URL resolution.

- [ ] **Step 5: Build and verify the final stylesheet**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run build:react
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  node packages/react/scripts/verify-css.mjs packages/react/dist/styles.css
```

Expected: PASS; font assets appear under `packages/react/dist/assets`; `styles.css` contains full cockpit utilities and no unsafe global selector.

- [ ] **Step 6: Run focused tests and both UI typechecks**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project react packages/react/scripts packages/react/src/cockpit.test.tsx
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project web packages/web/src/components/ui packages/web/src/components/zoomable-image.test.tsx packages/web/src/cockpit-implementation.test.tsx
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run typecheck:react
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run typecheck:web
```

Expected: all checks PASS.

- [ ] **Step 7: Commit CSS and portal containment**

```bash
git add packages/react/src/styles packages/react/scripts packages/web/src/styles packages/web/src/components
git commit -m "fix(react): scope complete cockpit styles and portals"
```

---

### Task 4: Prove the packed facade and make the browser packages publishable

**Files:**
- Create: `fixtures/cockpit-consumer/package.json`
- Create: `fixtures/cockpit-consumer/tsconfig.json`
- Create: `fixtures/cockpit-consumer/vite.config.ts`
- Create: `fixtures/cockpit-consumer/src/main.tsx`
- Create: `scripts/check-cockpit-pack.mjs`
- Create: `scripts/check-cockpit-pack.test.mjs`
- Create: `packages/react/README.md`
- Modify: `package.json`
- Modify: `packages/contract/package.json`
- Modify: `packages/api-client/package.json`
- Modify: `packages/react/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: packed contract, API-client, and React workspaces.
- Produces: `npm run test:cockpit-package`; installable and npm-publishable contract,
  API-client, `@open-mercato/cezar-react/cockpit`, and `styles.css` tarballs.

- [ ] **Step 1: Write the cold-consumer fixture and package-gate unit tests**

The fixture imports only public package paths:

```tsx
import { createCezarClient } from '@open-mercato/cezar-api-client'
import { CezarCockpit } from '@open-mercato/cezar-react/cockpit'
import '@open-mercato/cezar-react/styles.css'

const client = createCezarClient({
  baseUrl: 'https://cezar.example.test',
  credentials: 'include',
})

createRoot(document.getElementById('root')!).render(
  <CezarCockpit client={client} routing={{ mode: 'memory', initialPath: '/' }} />,
)
```

Write `check-cockpit-pack.test.mjs` first. It imports the not-yet-created fixture copier and
scanner from `check-cockpit-pack.mjs`, proves only the explicit fixture files are copied, and
proves each forbidden marker below is rejected while ordinary `packages/web` prose in a README is
not scanned as runtime code:

```js
const forbidden = [
  /packages[/\\]web/,
  /@open-mercato[/\\]cezar-web/,
  /#cezar-web-cockpit/,
  /src[/\\]cockpit-implementation/,
]
```

The eventual gate must build all three workspaces, pack each to a temporary directory, install the
tarballs plus React 19 into a fresh copied fixture, run `tsc --noEmit`, run Vite, and apply this
scanner to installed declaration and JavaScript files. It must also assert the packed React
manifest includes `dist/cockpit.js`, `dist/cockpit.d.ts`, `dist/styles.css`, private chunks, and
font assets.

- [ ] **Step 2: Run the package-gate unit test and verify RED**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env node --test scripts/check-cockpit-pack.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` or a missing named export because the gate implementation
does not exist.

- [ ] **Step 3: Implement the cold pack/install/build gate and documentation**

Export the fixture-copy and runtime-scan helpers without running `main()` when the file is imported
by `node:test`. `main()` creates a `mkdtemp` directory, builds and packs contract/API-client/React,
installs the three tarballs plus exact React 19 peer versions with `--ignore-scripts --no-save`,
typechecks the fixture, builds it, scans installed runtime/declaration files, and always removes the
temporary directory in `finally`.

Add:

```json
"test:cockpit-package": "node --test scripts/check-cockpit-pack.test.mjs && node scripts/check-cockpit-pack.mjs"
```

Document the exact minimal embed:

```tsx
import { createCezarClient } from '@open-mercato/cezar-api-client'
import { CezarCockpit } from '@open-mercato/cezar-react/cockpit'
import '@open-mercato/cezar-react/styles.css'

<CezarCockpit
  client={createCezarClient({ baseUrl, credentials: 'include' })}
  routing={{ mode: 'memory', initialPath: '/' }}
/>
```

State that memory routing leaves the host URL untouched, the cockpit owns its complete internal routes, one instance per host panel is supported, and advanced appearance composition remains available through `CezarProvider`.

- [ ] **Step 4: Run the packed consumer while the packages are still private**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run test:cockpit-package
```

Expected: PASS from a fresh temporary install; public imports typecheck/build; no private source
path survives. This is the required pre-publication local proof.

- [ ] **Step 5: Open the three browser packages for publication**

After the local packed-consumer gate passes, remove `private: true` from contract, API-client, and React; add `publishConfig.access = "public"` and repository metadata where missing. Keep the workspace root and `packages/web` private.

Run `npm install --package-lock-only --ignore-scripts` at the workspace root to update the lockfile
metadata. This makes the three package manifests individually publishable; it does not run
`npm publish`. Adding React to the repository's automated stable/snapshot release orchestration is
a separate release-engineering subproject after local sandbox validation, not part of the dev-mode
critical path.

- [ ] **Step 6: Re-run the cold consumer and public package assertions**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run test:cockpit-package
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env \
  npm test -- --project react packages/react/src/public-api.test.ts packages/react/src/cockpit.test.tsx
```

Expected: the cold consumer still passes with publishable manifests and the public export tests
PASS.

- [ ] **Step 7: Run the five repository gates once in order**

Run exactly:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run typecheck
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm test
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm run test:unit
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm_config_cache=/private/tmp/cezar-npm-cache npm run build
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env npm_config_cache=/private/tmp/cezar-npm-cache npm run test:package
```

Expected: all five PASS. If sandbox process/network restrictions produce `EPERM`, capture the exact original result and rerun only that unchanged gate in an approved controller context.

- [ ] **Step 8: Commit package readiness**

```bash
git add fixtures/cockpit-consumer scripts/check-cockpit-pack.mjs scripts/check-cockpit-pack.test.mjs packages/contract/package.json packages/api-client/package.json packages/react package.json package-lock.json
git commit -m "feat(react): pack complete cezar cockpit"
```

---

### Task 5: Validate standalone behavior through the shared implementation

**Files:**
- Modify: `packages/web/e2e/new-task.e2e.ts`
- Modify: `packages/web/e2e/smoke.e2e.ts`
- Create: `packages/web/e2e/cockpit-facade.e2e.ts`

**Interfaces:**
- Consumes: the built standalone app, now rendered through `CezarCockpit` in browser-routing mode.
- Produces: real-Chrome evidence that the shared private composition still creates a task and navigates the complete route tree.

- [ ] **Step 1: Add a shared-facade browser smoke**

Drive the existing dry-run server and assert:

```ts
expect(await browser.locator('[data-cezar-routing="browser"]').count()).toBe(1)
expect(await browser.locator('iframe').count()).toBe(0)
await browser.click('a[href$="/new"]')
await browser.fill('textarea', 'Verify the coarse cockpit facade')
await browser.click('button[type="submit"]')
await browser.waitForUrl(/\/tasks\//)
```

Navigate Git, GitHub (or its truthful unavailable state), Settings, Workflows, Skills, and Tasks through the existing sidebar; assert each existing route marker, not copied content.

- [ ] **Step 2: Run the real-browser suite**

Run:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH BASH_ENV=/private/tmp/cezar-node24-bash-env CEZ_DRY_RUN=1 npm run test:e2e
```

Expected: `TEST_E2E_STATUS=passed`. A `skipped` marker is not a pass and requires manual Chrome verification during the Mercato cutover.

- [ ] **Step 3: Commit standalone browser evidence**

```bash
git add packages/web/e2e
git commit -m "test(web): verify shared cockpit facade in chrome"
```

---

## Completion Evidence

- `git diff --stat 3625a074...HEAD` remains a coarse-facade change, not a feature migration.
- `npm run test:cockpit-package` passes from packed tarballs.
- The five repository gates pass in order.
- Standalone Cezar creates a task and navigates existing routes through the shared facade.
- `packages/react/dist` contains the facade, private route chunks, CSS, and fonts but no private source import.
- No iframe is present anywhere in the cockpit implementation.
