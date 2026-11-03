import { webhookInvalidationSchema, type WebhookInvalidation } from '@open-mercato/cezar-contract'
/** A project-specific stream carries invalidations only; ignore unknown or malformed frames. */
export function decodeWebhookInvalidation(type: string, data: string): WebhookInvalidation | undefined {
  if ((type !== 'change' && type !== 'resync') || data.length > 1024) return
  try {
    const value: unknown = JSON.parse(data)
    if (!value || typeof value !== 'object' || Array.isArray(value) || 'type' in value) return
    const parsed = webhookInvalidationSchema.safeParse({ ...value, type })
    return parsed.success ? parsed.data : undefined
  } catch { return }
}
