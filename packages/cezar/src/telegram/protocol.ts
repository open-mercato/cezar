import { z } from 'zod';

const integer = z.number().int().safe();
const person = z.object({ id: integer.positive(), is_bot: z.boolean(), first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(), username: z.string().max(64).optional() });
const chat = z.object({ id: integer.refine(id => id !== 0), type: z.enum(['private', 'group', 'supergroup', 'channel']), title: z.string().max(256).optional(), is_forum: z.boolean().optional() });
const message = z.object({
  message_id: integer.positive(), date: integer.nonnegative(), chat, from: person.optional(), text: z.string().max(65536).optional(),
  entities: z.array(z.object({ type: z.string().max(64), offset: integer.nonnegative(), length: integer.positive() })).max(100).optional(),
  reply_to_message: z.object({ message_id: integer.positive() }).optional(),
  forward_origin: z.unknown().optional(), via_bot: z.unknown().optional(), sender_chat: z.unknown().optional(),
  photo: z.unknown().optional(), document: z.unknown().optional(), video: z.unknown().optional(), audio: z.unknown().optional(),
  voice: z.unknown().optional(), sticker: z.unknown().optional(), animation: z.unknown().optional(),
  message_thread_id: integer.optional(), is_topic_message: z.boolean().optional(),
  migrate_to_chat_id: integer.optional(), migrate_from_chat_id: integer.optional(),
});
export const telegramUpdateSchema = z.object({
  update_id: integer.nonnegative().max(Number.MAX_SAFE_INTEGER - 1), message: message.optional(),
  callback_query: z.object({ id: z.string().min(1).max(128), from: person, data: z.string().max(64).optional(),
    message: z.object({ message_id: integer.positive(), chat }).optional() }).optional(),
  my_chat_member: z.object({ chat, new_chat_member: z.object({ status: z.string().max(64) }) }).optional(),
});
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
export type TelegramMessage = NonNullable<TelegramUpdate['message']>;

export function eligibleText(message: TelegramMessage, groups = false): boolean {
  return typeof message.text === 'string' && message.from?.is_bot === false
    && (message.chat.type === 'private' || (groups && ['group', 'supergroup'].includes(message.chat.type)))
    && !message.chat.is_forum && !message.is_topic_message && message.message_thread_id === undefined
    && ['forward_origin', 'via_bot', 'sender_chat', 'photo', 'document', 'video', 'audio', 'voice', 'sticker', 'animation']
      .every(key => message[key as keyof TelegramMessage] === undefined);
}
/** The one list of conversation commands: the bot menu, help and routing all read it. */
export const TELEGRAM_COMMANDS = [
  { command: 'task', description: 'Start a new task (you confirm it first)' },
  { command: 'tasks', description: 'List this project’s tasks' },
  { command: 'status', description: 'Show a task’s status' },
  { command: 'reply', description: 'Answer a task that is waiting for you' },
  { command: 'cancel', description: 'Cancel a task' },
  { command: 'continue', description: 'Continue a task' },
  { command: 'help', description: 'Show what this bot can do' },
] as const;
export type TelegramCommandName = typeof TELEGRAM_COMMANDS[number]['command'];
const conversationCommands: ReadonlySet<string> = new Set(TELEGRAM_COMMANDS.map(row => row.command));
export const isTelegramCommand = (name: string): name is TelegramCommandName => conversationCommands.has(name);
// `start` is parsed for pairing links only; the conversation answers it with help.
const commands = new Set([...conversationCommands, 'start']);
export type Command = { kind: 'command'; name: string; args: string } | { kind: 'ignore' | 'text' | 'unknown' };
export function parseCommand(message: TelegramMessage, username: string): Command {
  const text = message.text ?? '';
  const entity = message.entities?.find(entity => entity.type === 'bot_command' && entity.offset === 0);
  if (!entity) return text.startsWith('/') ? { kind: 'unknown' } : { kind: 'text' };
  const token = text.slice(0, entity.length);
  const match = /^\/([a-zA-Z0-9_]{1,32})(?:@([a-zA-Z0-9_]{1,64}))?$/.exec(token);
  if (!match || (text.length > entity.length && !/\s/.test(text[entity.length]!))) return { kind: 'unknown' };
  if (match[2] && match[2].toLowerCase() !== username.toLowerCase()) return { kind: 'ignore' };
  const name = match[1]!.toLowerCase();
  return commands.has(name) ? { kind: 'command', name, args: text.slice(entity.length).trim() } : { kind: 'unknown' };
}
export function freshMessage(date: number, acceptAfter: number, now: number): boolean {
  const at = date * 1000;
  return at >= acceptAfter && at >= now - 15 * 60_000 && at <= now + 60_000;
}
export function resolveTask<T extends { id: string; archived?: boolean }>(reference: string, runs: readonly T[]): T | undefined {
  if (!/^[0-9a-f-]{8,36}$/i.test(reference)) return undefined;
  const matches = runs.filter(run => !run.archived && run.id.toLowerCase().startsWith(reference.toLowerCase()));
  return matches.length === 1 ? matches[0] : undefined;
}
