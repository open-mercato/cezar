import {
  providerAuthChecksDisabled,
  type ProviderId,
  type ProviderStatus,
  type ProviderStatusResponse,
} from './provider-auth.ts';

export function applyProviderEnablement(
  response: ProviderStatusResponse,
  disabledProviders: readonly ProviderId[],
): ProviderStatusResponse {
  const disabled = new Set(
    providerAuthChecksDisabled() ? [] : disabledProviders,
  );
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
