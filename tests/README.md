# Cockpit e2e suite

Agentic end-to-end tests of the whole cockpit on the [`e2e`](https://github.com/e2e-inc/e2e)
runner. Every test boots the real server with the bundled mock agents (`CEZ_DRY_RUN=1`) on a
free port, against a throwaway fixture repository (`scripts/e2e-fixture-repo.mjs`), so runs
never touch this checkout's `.ai/cezar/` or your `~/.cezar`.

```bash
npm run build:web                 # once; the server serves packages/cezar/web/dist
npm run test:e2e:cockpit          # the whole suite: the `web` target, then the `review-gate` one
npm exec -- e2e run tests/settings.e2e.ts --headed   # one file, visible browser
E2E_SKIP_WEB_BUILD=1 npm exec -- e2e run             # reuse the built cockpit
```

The review gate is server-wide, so the tests tagged `review-gated` run on their own target
(`--target review-gate --tag review-gated`), booted with `CEZ_REVIEW_GATE=1`; everything else
runs on `web` with `--exclude-tag review-gated`.

A failed test names its trace page under `.e2e/results/<test>/trace.md`: every step, the
accessible tree at failure, and what the app logged.

The suite is deterministic (`screen` + `expect`) and needs no model. `agent.*` steps need the
model in `e2e.config.ts` (`OPENAI_API_KEY`, or `npx e2e login openai` for a ChatGPT
subscription; swap the provider for Anthropic/Gateway as the e2e docs describe).

This is separate from `npm run test:e2e`, the older agent-browser smoke suite under
`packages/web/e2e/`.
