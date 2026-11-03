import type { E2EConfig } from 'e2e'
import chatWebhooks from './chat-webhooks.config'

export default {
  ...chatWebhooks,
  tests: './webhooks-review.e2e.ts',
  output: '.e2e/webhooks-review',
} satisfies E2EConfig
