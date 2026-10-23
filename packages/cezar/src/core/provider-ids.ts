export const PROVIDER_IDS = ['claude', 'codex', 'opencode', 'cursor', 'pi', 'junie', 'copilot'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
