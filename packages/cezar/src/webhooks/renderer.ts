import { webhookEventSchema } from '@open-mercato/cezar-contract';
import { readableCompletionReason, type ChatPresentation } from '../chat/presentation.ts';
/** Render only the already consent-filtered webhook payload through the actual bot provider. */
export function renderChatNotification(body: string, presentation: ChatPresentation, chatId: string, receiverName: string, replyable: boolean): string {
  const event = webhookEventSchema.parse(JSON.parse(body));
  if (event.type === 'webhook.test') return presentation.formatText(`Test message · cezar is connected to this chat · ${receiverName}`, presentation.maxText);
  return presentation.taskReply({ id: event.task.id, title: event.task.title ?? event.task.id, status: event.task.status,
    ...(event.type === 'task.failed' ? { error: event.data.message } : {}),
    ...(event.type === 'task.finished' ? { result: readableCompletionReason[event.data.resolution] } : {}),
    ...(event.type === 'task.attention_required' ? { questions: event.data.questions, excerpt: event.data.agentExcerpt } : {}),
    links: { pullRequest: event.links?.pullRequest, issue: event.links?.issue, ...(event.source.mode === 'hosted' ? { cockpit: event.links?.cockpit } : {}) },
    privateChat: !presentation.isGroup(chatId), replyable,
  });
}
