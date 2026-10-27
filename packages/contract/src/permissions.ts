import { z } from 'zod';

/** Canonical `Tool` / `Tool(pattern)` specifier (claude settings / #475 advanced rules). */
export const PERMISSION_SPECIFIER_RE = /^[A-Za-z][A-Za-z0-9_-]*(\(.+\))?$/;

export const permissionSpecifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(PERMISSION_SPECIFIER_RE, 'must be Tool or Tool(pattern)');

export const permissionModeSchema = z.enum(['auto', 'guarded', 'read-only', 'manual']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const permissionRulesSchema = z
  .object({
    allow: z.array(permissionSpecifierSchema).max(100).optional(),
    ask: z.array(permissionSpecifierSchema).max(100).optional(),
    deny: z.array(permissionSpecifierSchema).max(100).optional(),
  })
  .strict();
export type PermissionRules = z.infer<typeof permissionRulesSchema>;

export const permissionSpecSchema = z.object({
  mode: permissionModeSchema,
  rules: permissionRulesSchema.optional(),
});
export type PermissionSpec = z.infer<typeof permissionSpecSchema>;
