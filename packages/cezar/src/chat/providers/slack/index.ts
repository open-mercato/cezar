import type { ChatServiceDescriptor } from '../../provider.ts';
import { slackCredentials, slackIds, decodeSlackCredentials } from './identity.ts';
import { slackPresentation } from './presentation.ts';
export const slackServiceDescriptor: ChatServiceDescriptor = {
 id: 'slack', label: 'Slack', format: 'slack.v1', credentials: slackCredentials, ids: slackIds, presentation: slackPresentation,
 limits: { maxText: 4000, buttonsPerMessage: 25, perChatPerSecond: 1, perBotPerSecond: 10 },
 destination(credential) { decodeSlackCredentials(credential); return 'https://slack.com/api/chat.postMessage'; },
 credentialBotId: () => undefined, textFormat: 'slack-mrkdwn',
 // Refresh material and the Client Secret stay in the host, even for an installed adapter without slack-oauth-v1.
 adapterCredential(stored) { const { appToken, botToken } = decodeSlackCredentials(stored); return JSON.stringify({ appToken, botToken }); },
};
