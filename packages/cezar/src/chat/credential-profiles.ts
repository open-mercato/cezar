import type { SecretScopeRef, SecretStore } from '../workspace/secrets.ts'

type CredentialProfile = { accessToken: (stored: string, slot: 'app' | 'bot', signal?: AbortSignal, valid?: () => boolean) => Promise<string> }

/** Host-held credential profiles an adapter may declare: refresh material never reaches the worker.
 *  This host implements none yet, so a declared profile gets no access token. */
export function chatCredentialProfile(_profile: 'slack-oauth-v1', _scope: Extract<SecretScopeRef, { kind: 'project' }>, _secrets: SecretStore, _home: string): CredentialProfile | undefined {
  return undefined
}
