import { z } from 'zod';

/** Optional execution treatment. Absence preserves the backend's native automatic behavior. */
export const executionAccessModeSchema = z.enum(['standard', 'daybreak-blue']);
export type ExecutionAccessMode = z.infer<typeof executionAccessModeSchema>;
