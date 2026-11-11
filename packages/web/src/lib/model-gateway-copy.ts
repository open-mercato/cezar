/**
 * Every marketing line about the model gateway (spec 2026-11-10-model-gateway), in one place so the
 * copy can be rewritten without touching a component. Placeholder wording until the final pass.
 */

/** Where every promo links: the gateway's own tab in Settings → Agent accounts. */
export const MODEL_GATEWAY_SETTINGS_PATH = '/settings/global/accounts#openmercato-gateway'

export const MODEL_GATEWAY_COPY = {
  /** "What's new" and the welcome page's big card. */
  announcement: {
    title: 'OpenMercato Gateway is here',
    description: 'Paste one OpenMercato Gateway key and code with its OpenAI-compatible models on OpenCode.',
    action: 'Add your key',
  },
  /** The line under the welcome page's composer, there whatever the big card announces. */
  welcome: {
    text: 'OpenMercato Gateway: one API key, many models on OpenCode.',
    action: 'Add your key',
  },
  /** The slim strip at the top of every page. */
  banner: {
    eyebrow: 'NEW',
    text: 'OpenMercato Gateway now runs OpenCode through one API key.',
    action: 'Set it up',
  },
} as const
