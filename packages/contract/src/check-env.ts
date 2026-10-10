import { z } from 'zod';

/**
 * Project check credentials (spec `2026-10-06-agentic-e2e-checks` Phase 1): values handed to a
 * workflow's CHECK steps only, never to an agent session. The API speaks names; a value goes in
 * once and never comes back out, not even masked.
 */

/** A value's upper bound: 16 KiB of UTF-8 (a service-account JSON fits, a log file does not). */
export const CHECK_ENV_VALUE_MAX_BYTES = 16 * 1024;

const NAME_SHAPE = /^[A-Z_][A-Z0-9_]{0,127}$/;
/** Names a check could use to change how the shell, the loader or cezar itself behaves. */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'TMPDIR', 'TEMP', 'TMP',
  'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV',
]);

/** Why `name` cannot be a check credential, or `null` when it can. One rule for every caller. */
export function checkEnvNameIssue(name: string): string | null {
  if (!NAME_SHAPE.test(name)) {
    return 'a name is 1–128 characters: uppercase letters, digits and underscores, not starting with a digit';
  }
  if (name.startsWith('CEZ_')) return 'CEZ_* names are reserved for cezar';
  if (name.startsWith('DYLD_')) return 'DYLD_* names change how programs load and are refused';
  if (REFUSED_NAMES.has(name)) return `${name} changes how the check's shell runs and is refused`;
  return null;
}

export const checkEnvNameSchema = z.string().superRefine((name, ctx) => {
  const issue = checkEnvNameIssue(name);
  if (issue) ctx.addIssue({ code: 'custom', message: issue });
});

export const checkEnvParamsSchema = z.object({ name: checkEnvNameSchema });
export type CheckEnvParams = z.infer<typeof checkEnvParamsSchema>;

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
 * Why `value` cannot be a check credential, or `null` when it can — the value twin of
 * `checkEnvNameIssue`, so the route, the store and the CLI cannot drift. They did: the schema
 * accepted `""` that the CLI and the cockpit both refuse, and an empty value does not read as
 * "unset" — it SHADOWS the server's own variable of that name with the empty string, because a
 * check step runs with `{ ...process.env, ...checkEnv }`.
 */
export function checkEnvValueIssue(value: string): string | null {
  if (value === '') return 'a value is not empty; remove the name instead of storing nothing';
  if (utf8ByteLength(value) > CHECK_ENV_VALUE_MAX_BYTES) {
    return `a value is at most ${CHECK_ENV_VALUE_MAX_BYTES} bytes`;
  }
  if (/[\r\n\0]/.test(value)) return 'a value is one line, without NUL';
  return null;
}

export const checkEnvValueInputSchema = z.object({
  value: z.string().superRefine((value, ctx) => {
    const issue = checkEnvValueIssue(value);
    if (issue) ctx.addIssue({ code: 'custom', message: issue });
  }),
});
export type CheckEnvValueInput = z.infer<typeof checkEnvValueInputSchema>;

/** `GET /check-env`: the stored names, sorted. Values never leave the machine's store. */
export const checkEnvNamesSchema = z.object({ names: z.array(z.string()) });
export type CheckEnvNames = z.infer<typeof checkEnvNamesSchema>;

export const checkEnvErrorSchema = z.object({ error: z.string() }).strict();
export type CheckEnvErrorResponse = z.infer<typeof checkEnvErrorSchema>;
