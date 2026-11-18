import { z } from 'zod';
import { chatIdentifierSchemas, chatSchemas } from './chat.ts';
export const discordBotTokenSchema = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/);
const ids = chatIdentifierSchemas.discord;
/** Shared HTTP factory uses one ID position for actor and chat; persisted roles stay precise. */
export const discordSchemas = chatSchemas(z.union([ids.chat, ids.user]), ids.bot, ids.bot, discordBotTokenSchema);
