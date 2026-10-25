import { z } from 'zod';

/**
 * Project and workspace secrets (spec `2026-10-10-project-secrets-vault-options`, superseding
 * the `check-env` half of `2026-10-06-agentic-e2e-checks` Phase 1).
 *
 * A secret is a named value with a SCOPE (one project, or the whole workspace) and a list of
 * AUDIENCES — who may read it. The API speaks names and metadata; a value goes in once and
 * never comes back out, not even masked. An agent session is never an audience: the type has
 * no such member, so no route, store or workflow can hand one to a backend.
 */

/** A value's upper bound: 16 KiB of UTF-8 (a service-account JSON fits, a log file does not). */
export const SECRET_VALUE_MAX_BYTES = 16 * 1024;

/**
 * Who may read a secret.
 * - `checks`: a workflow's check steps (`command:`), as environment variables.
 * - `cezar`: cezar's own features (an LLM key for cezar-level actions). Reserved for consumers
 *   that read through the store's `cezar` audience; nothing ships one yet.
 */
export const SECRET_AUDIENCES = ['checks', 'cezar'] as const;
export const secretAudienceSchema = z.enum(SECRET_AUDIENCES);
export type SecretAudience = z.infer<typeof secretAudienceSchema>;

/** Where a secret lives: with one project, or with the user's whole workspace. */
export const SECRET_SCOPES = ['project', 'workspace'] as const;
export const secretScopeSchema = z.enum(SECRET_SCOPES);
export type SecretScope = z.infer<typeof secretScopeSchema>;

/**
 * Where the data key that encrypts this machine's secret files lives: the OS keychain
 * (macOS Keychain, Linux Secret Service, Windows Credential Manager) or, when none is
 * available, a `0600` key file beside the secret files — which makes the store exactly as
 * strong as a private plaintext file, and the cockpit says so.
 */
export const secretKeyBackendSchema = z.enum(['keychain', 'file']);
export type SecretKeyBackend = z.infer<typeof secretKeyBackendSchema>;

const NAME_SHAPE = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Names a check could use to change how the shell, the loader or cezar itself behaves. */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'TMPDIR', 'TEMP', 'TMP',
  'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV',
]);

/** Why `name` cannot be a secret, or `null` when it can. One rule for every caller. */
export function secretNameIssue(name: string): string | null {
  if (!NAME_SHAPE.test(name)) {
    return 'a name is 1–128 characters: uppercase letters, digits and underscores, not starting with a digit';
  }
  if (name.startsWith('CEZ_')) return 'CEZ_* names are reserved for cezar';
  if (name.startsWith('DYLD_')) return 'DYLD_* names change how programs load and are refused';
  if (REFUSED_NAMES.has(name)) return `${name} changes how the check's shell runs and is refused`;
  return null;
}

export const secretNameSchema = z.string().superRefine((name, ctx) => {
  const issue = secretNameIssue(name);
  if (issue) ctx.addIssue({ code: 'custom', message: issue });
});

export const secretParamsSchema = z.object({ name: secretNameSchema });
export type SecretParams = z.infer<typeof secretParamsSchema>;

/** UTF-8 length without `TextEncoder`, which this Node-free package's `lib` does not declare. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Why `value` cannot be a secret, or `null` when it can — the value twin of
 * `secretNameIssue`, so the route, the store and the CLI cannot drift. An empty value does not
 * read as "unset" — it SHADOWS the server's own variable of that name with the empty string,
 * because a check step runs with `{ ...process.env, ...secrets }`.
 */
export function secretValueIssue(value: string): string | null {
  if (value === '') return 'a value is not empty; remove the name instead of storing nothing';
  if (utf8ByteLength(value) > SECRET_VALUE_MAX_BYTES) {
    return `a value is at most ${SECRET_VALUE_MAX_BYTES} bytes`;
  }
  if (/[\r\n\0]/.test(value)) return 'a value is one line, without NUL';
  return null;
}

/**
 * `PUT /secrets/:name`: the value, and who may read it. `audiences` omitted means `['checks']`
 * — the one consumer that exists today, and what the first release of this store meant by a
 * secret. Setting a name that exists REPLACES it, audiences included.
 */
export const secretValueInputSchema = z.object({
  value: z.string().superRefine((value, ctx) => {
    const issue = secretValueIssue(value);
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  }),
  audiences: z.array(secretAudienceSchema).min(1).optional(),
});
export type SecretValueInput = z.infer<typeof secretValueInputSchema>;

/** One stored secret as the API describes it: everything but the value. */
export const secretEntrySchema = z.object({
  name: z.string(),
  audiences: z.array(secretAudienceSchema),
  updatedAt: z.string(),
});
export type SecretEntry = z.infer<typeof secretEntrySchema>;

/**
 * `GET /secrets` and `GET /workspace/secrets`: the stored entries, sorted by name, and the key
 * backend this machine encrypts with. Values never leave the machine's store.
 */
export const secretsListSchema = z.object({
  secrets: z.array(secretEntrySchema),
  keyBackend: secretKeyBackendSchema,
});
export type SecretsList = z.infer<typeof secretsListSchema>;

export const secretsErrorSchema = z.object({ error: z.string() }).strict();
export type SecretsErrorResponse = z.infer<typeof secretsErrorSchema>;

/**
 * A check step's `secrets:` binding (workflow YAML): the secrets it may read, by name, each
 * optionally renamed on the way in (`as`). Absent means every secret whose audiences include
 * `checks`; present means exactly these, and a listed name that is not stored is said on the
 * step rather than silently absent.
 */
export const stepSecretBindingSchema = z.union([
  secretNameSchema,
  z.object({ name: secretNameSchema, as: secretNameSchema.optional() }).strict(),
]);
export type StepSecretBinding = z.infer<typeof stepSecretBindingSchema>;
export const stepSecretsSchema = z.array(stepSecretBindingSchema).min(1);
