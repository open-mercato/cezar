import type { ChatServiceDescriptor } from '../../provider.ts';
import { slackCredentials, slackIds, decodeSlackCredentials } from './identity.ts';
import { slackPresentation } from './presentation.ts';
export const slackServiceDescriptor: ChatServiceDescriptor = {
 id: 'slack', label: 'Slack', format: 'slack.v1', credentials: slackCredentials, ids: slackIds, presentation: slackPresentation,
 limits: { maxText: 4000, buttonsPerMessage: 25, perChatPerSecond: 1, perBotPerSecond: 10 },
 destination(credential) { decodeSlackCredentials(credential); return 'https://slack.com/api/chat.postMessage'; },
 credentialBotId: () => undefined, textFormat: 'slack-mrkdwn',
};
