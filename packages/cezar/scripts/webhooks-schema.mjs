// Run from the repository: node --import tsx packages/cezar/scripts/webhooks-schema.mjs
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { webhookEventSchema } from '@open-mercato/cezar-contract';
await writeFile(new URL('../docs/webhooks.schema.json', import.meta.url), JSON.stringify(z.toJSONSchema(webhookEventSchema), null, 2) + '\n');
