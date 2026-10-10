import { resolve } from 'node:path';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { openai } from '@ai-sdk/openai';

export default {
  // Reads OPENAI_API_KEY from the environment.
  agents: {
    default: {
      model: openai('gpt-6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome.',
    },
  },
  targets: [{
    engine: web(),
    app: {
      // Port 0: every run (and every parallel cezar task) gets its own free port.
      url: 'http://127.0.0.1:0',
      readyUrl: 'http://127.0.0.1:{port}/api/v1/health',
      // The server serves the built cockpit (packages/cezar/web/dist), so build it first.
      command: {
        executable: 'sh',
        args: ['-c', 'npm run build:web && exec npm run dev:server -- --port "$PORT" --no-open'],
        env: {
          PORT: '{port}',
          // Bundled mock agents: no CLI login, no network. CEZ_HOME keeps ~/.cezar untouched.
          CEZ_DRY_RUN: '1',
          CEZ_NO_BANNER: '1',
          CEZ_SKILLS_AUTO_UPDATE: '0',
          CEZ_HOME: resolve('.e2e/cez-home'),
        },
        startupTimeout: 180_000,
        log: '.e2e/logs/app.log',
      },
    },
  }],
} satisfies E2EConfig;
