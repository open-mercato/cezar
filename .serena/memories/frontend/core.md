# React Cockpit
- Source: `web/app/`; built assets: ignored `web/dist/`.
- Start at `web/app/src/app.tsx`, then `routes.tsx`, `api/`, and affected route/component.
- Keep one global SSE connection and patch TanStack Query cache in place; authoritative refetch is on reconnect/visibility.
- All project views live under `/p/:projectId/`; legacy flat paths redirect to the boot project; global settings are `/settings/global`.
- Preserve light/dark/system themes, mobile safe areas, keyboard access, and unit coverage.
- When `web/dist` is absent, server shell routes intentionally return the build-hint page from `src/server/static-ui.ts`.
