import type {
  ProviderId,
  ProviderStatus,
  ProviderStatusResponse,
} from './provider-auth.js';

export function applyProviderEnablement(
  response: ProviderStatusResponse,
  disabledProviders: readonly ProviderId[],
): ProviderStatusResponse {
  const disabled = new Set(disabledProviders);
  return {
    providers: response.providers.map((row) => ({
      ...row,
      enabled: !disabled.has(row.provider),
    })),
  };
}

export function isProviderUsable(row: ProviderStatus): boolean {
  return row.enabled !== false && row.status === 'connected';
}
