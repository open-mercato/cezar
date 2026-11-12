import { resolve } from 'node:path';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { openai } from '@ai-sdk/openai';

/**
 * The cockpit e2e suite (`tests/**\/*.e2e.ts`): the real server, the built cockpit, bundled
 * mock agents (`CEZ_DRY_RUN=1`), and a throwaway fixture repository per run so parallel runs
 * never share a `.ai/cezar/` store. Tests are deterministic (`screen` + `expect`); `agent.*`
 * steps need a model, see `agents` below.
 *
 * Two targets, one server each: `web` is the zero-config cockpit; `review-gate` boots with
 * `CEZ_REVIEW_GATE=1` for the tests tagged `review-gated`, because the gate is a server-wide
 * setting and flipping it mid-run would park every other file's task at `review`.
 * `npm run test:e2e:cockpit` runs both selections.
 *
 * `E2E_SKIP_WEB_BUILD=1` reuses an existing `packages/cezar/web/dist` (after `npm run build:web`).
 */
function cockpit(extraEnv: Record<string, string> = {}) {
  return {
    engine: web(),
    app: {
      // Port 0: every run (and every parallel cezar task) gets its own free port.
      url: 'http://127.0.0.1:0',
      readyUrl: 'http://127.0.0.1:{port}/api/v1/health',
      command: {
        executable: 'sh',
        args: [
          '-c',
          [
            '[ "${E2E_SKIP_WEB_BUILD:-0}" = 1 ] || npm run build:web',
            'node scripts/e2e-fixture-repo.mjs "$E2E_REPO"',
            'exec npm run dev:server -- --repo "$E2E_REPO" --port "$PORT" --no-open',
          ].join(' && '),
        ],
        env: {
          PORT: '{port}',
          E2E_REPO: resolve('.e2e/fixtures/repo-{port}'),
          // Bundled mock agents: no CLI login, no network. CEZ_HOME keeps ~/.cezar untouched,
          // one per port so two runs never share a project registry.
          CEZ_DRY_RUN: '1',
          CEZ_NO_BANNER: '1',
          CEZ_SKILLS_AUTO_UPDATE: '0',
          CEZ_TELEMETRY: '0',
          CEZ_HOME: resolve('.e2e/cez-home/{port}'),
          ...extraEnv,
        },
        startupTimeout: 180_000,
        log: '.e2e/logs/app-{port}.log',
      },
    },
  };
}

export default {
  // Reads OPENAI_API_KEY from the environment; `npx e2e login openai` for a ChatGPT subscription.
  agents: {
    default: {
      model: openai('gpt-6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  timeout: 90_000,
  targets: [
    { name: 'web', ...cockpit() },
    { name: 'review-gate', ...cockpit({ CEZ_REVIEW_GATE: '1' }) },
  ],
} satisfies E2EConfig;
