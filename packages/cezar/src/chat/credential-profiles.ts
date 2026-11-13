import type { SecretScopeRef, SecretStore } from '../workspace/secrets.ts'
import { decodeSlackCredentials } from './providers/slack/identity.ts'
import { SlackTokenRotation, slackRotationStorage } from './providers/slack/rotation.ts'

/** Host-held credential profiles an adapter may declare: refresh material never reaches the worker. */
export function chatCredentialProfile(_profile: 'slack-oauth-v1', scope: Extract<SecretScopeRef, { kind: 'project' }>, secrets: SecretStore, home: string) {
  const rotation = new SlackTokenRotation(slackRotationStorage(scope, secrets, home))
  return { accessToken: (stored: string, slot: 'app' | 'bot', signal?: AbortSignal, valid?: () => boolean) => rotation.token(decodeSlackCredentials(stored), slot, signal, valid) }
}
