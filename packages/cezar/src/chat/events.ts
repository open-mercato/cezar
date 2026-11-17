import { z } from 'zod';
import { chatIdSchema } from './provider.ts';
export const CHAT_COMMANDS = [
  { command: 'task', description: 'Start a new task (you confirm it first)' },
  { command: 'tasks', description: 'List this project’s tasks' },
  { command: 'status', description: 'Show a task’s status' },
  { command: 'reply', description: 'Answer a task that is waiting for you' },
  { command: 'cancel', description: 'Cancel a task' },
  { command: 'continue', description: 'Continue a task' },
  { command: 'help', description: 'Show what this bot can do' },
] as const;
export type ChatCommandName = typeof CHAT_COMMANDS[number]['command'];
export const isChatCommand = (name: string): name is ChatCommandName => CHAT_COMMANDS.some(row => row.command === name);
export const commandSchema = z.union([z.object({ kind: z.literal('command'), name: z.string(), args: z.string() }), z.object({ kind: z.enum(['ignore', 'text', 'unknown']) })]);
export const inputMessageSchema = z.object({
  id: chatIdSchema, at: z.number().int().nonnegative(),
  chat: z.object({ id: chatIdSchema, kind: z.enum(['private', 'group']), title: z.string().max(256).optional() }),
  user: z.object({ id: chatIdSchema, label: z.string().max(256), username: z.string().max(128).optional() }),
  pairingEligible: z.boolean().optional(), text: z.string().max(65536), addressed: z.boolean(), command: commandSchema,
  replyTo: chatIdSchema.optional(),
});
export type InputMessage = z.infer<typeof inputMessageSchema>;
export const inputUpdateSchema = z.object({
  /** Receive ordering within an epoch; not a platform user/chat/message identifier. */
  sequence: z.number().int().nonnegative().safe(),
  message: inputMessageSchema.optional(),
  button: z.object({ id: chatIdSchema, userId: chatIdSchema, chatId: chatIdSchema, messageId: chatIdSchema, data: z.string().max(128).optional() }).optional(),
  membership: z.object({ affected: z.array(chatIdSchema), reason: z.enum(['bot_removed', 'group_migrated']) }).optional(),
});
export type InputUpdate = z.infer<typeof inputUpdateSchema>;
export const freshMessage = (at: number, acceptAfter: number, now: number): boolean => at >= acceptAfter && at >= now - 15 * 60_000 && at <= now + 60_000;
export function resolveTask<T extends { id: string; archived?: boolean }>(reference: string, runs: readonly T[]): T | undefined {
  if (!/^[0-9a-f-]{8,36}$/i.test(reference)) return undefined;
  const matches = runs.filter(run => !run.archived && run.id.toLowerCase().startsWith(reference.toLowerCase()));
  return matches.length === 1 ? matches[0] : undefined;
}
