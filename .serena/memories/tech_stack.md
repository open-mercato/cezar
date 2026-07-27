# Tech Stack
- Strict TypeScript ESM, Node.js >=20, npm.
- CLI: Node `parseArgs`; server: Hono + SSE; validation: Zod at every boundary; workflows: YAML.
- UI: React 19, React Router 7, Vite 8, Tailwind v4, shadcn/Radix-style primitives, TanStack Query.
- Tests: Vitest for server/cockpit, `node:test` + tsx for core/package coverage; real-browser smoke suite via agent-browser.
- Built CLI entry is `dist/index.js`; package exposes `cezar`, `cez`, and `cezar-cli`.
