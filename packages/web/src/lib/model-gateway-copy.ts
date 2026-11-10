/**
 * Every marketing line about the model gateway (spec 2026-11-10-model-gateway), in one place so the
 * copy can be rewritten without touching a component. Placeholder wording until the final pass.
 */

/** Where every promo links: the gateway's own section in Settings → Agents. */
export const MODEL_GATEWAY_SETTINGS_PATH = '/settings/agents#model-gateway'

export const MODEL_GATEWAY_COPY = {
  /** "What's new" and the welcome page's big card. */
  announcement: {
    title: 'Any model, one API key',
    description: 'Paste an OpenRouter key — or your own OpenAI-compatible API — and code with hundreds of models on OpenCode.',
    action: 'Add your key',
  },
  /** The slim strip at the top of every page. */
  banner: {
    eyebrow: 'New',
    text: 'Code with any model through one API key — OpenRouter or your own API.',
    action: 'Set it up',
  },
} as const
