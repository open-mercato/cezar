import {
  PROVIDER_IDS,
  ProviderAuthService,
  type ProviderStatusResponse,
} from '../core/provider-auth.ts';

class ConnectedProviderAuthService extends ProviderAuthService {
  override status(): Promise<ProviderStatusResponse> {
    return Promise.resolve({
      providers: PROVIDER_IDS.map((provider) => ({ provider, status: 'connected' })),
    });
  }
}

/** Deterministic provider discovery for route tests whose subject is not auth gating. */
export function connectedProviderAuth(): ProviderAuthService {
  return new ConnectedProviderAuthService();
}
