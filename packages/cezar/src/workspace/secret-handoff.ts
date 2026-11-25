import { readFileSync } from 'node:fs';
import type { DataKeyring } from './secret-keyring.ts';

/** Names the file a launcher mounted the data key at; the path is not secret, the key never travels in env. */
export const HANDOFF_ENV = 'CEZ_HANDOFF_FILE';

export type HandoffResult = { keyring: DataKeyring } | { keyring: null; reason: string };

let loaded: HandoffResult | undefined;

/** Test seam: forget the one-time load. */
export function resetHandoffForTests(): void {
  loaded = undefined;
}

/**
 * The data key a launcher handed over as a file (vito #1077): read once into memory, then the
 * variable is removed so agent children do not inherit the path. `null` when no handoff is configured.
 * A configured but unusable handoff is a refusal, never a quiet fallback to a file key.
 */
export function handoffKeyring(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
): HandoffResult | null {
  if (loaded) return loaded;
  const path = env[HANDOFF_ENV];
  if (!path) return null;
  delete env[HANDOFF_ENV];
  if (env !== process.env) delete process.env[HANDOFF_ENV];
  let key: Buffer;
  try {
    key = Buffer.from(read(path).trim(), 'base64');
  } catch {
    return (loaded = { keyring: null, reason: `the handed-over data key at ${path} cannot be read` });
  }
  if (key.length !== 32) return (loaded = { keyring: null, reason: `the handed-over data key at ${path} is not a 32-byte key` });
  loaded = {
    keyring: {
      async get() {
        return Buffer.from(key);
      },
      async set() {
        throw new Error('the handed-over data key is read-only');
      },
    },
  };
  return loaded;
}
