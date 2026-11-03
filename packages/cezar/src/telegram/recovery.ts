import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { statePath } from '../webhooks/storage.ts';
import { telegramIdSchema, type BotBinding } from './state.ts';
/** Full streaming hash, bounded memory/time; never authorize reset with a partial hash. */
export async function stateFingerprint(directory: string, botId: string, binding: BotBinding): Promise<string> {
  telegramIdSchema.parse(botId);
  const hash = createHash('sha256').update(JSON.stringify([botId, binding.projectId, binding.root, binding.installationId, binding.generation]));
  let file;
  try { file = await open(statePath(directory, `${botId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return hash.update(':missing').digest('hex'); throw error; }
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('State is not a regular file');
    const until = Date.now() + 5000, bytes = Buffer.alloc(64 * 1024);
    hash.update(':file');
    while (true) {
      if (Date.now() >= until) throw new Error('State fingerprint timed out');
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      hash.update(bytes.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('State changed while reading');
    return hash.digest('hex');
  } finally { await file.close(); }
}
