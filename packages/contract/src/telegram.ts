import { z } from 'zod';
import { telegramBotTokenSchema } from './webhooks.ts';
import { chatSchemas } from './chat.ts';
const id = z.string().regex(/^-?[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
export const telegramSchemas = chatSchemas(id, id.refine(value => !value.startsWith('-')), z.string().regex(/^[A-Za-z0-9_]{1,64}$/), telegramBotTokenSchema);
