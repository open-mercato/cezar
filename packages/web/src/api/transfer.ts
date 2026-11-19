import {
  apiPath,
  configBundleImportResultSchema,
  configBundlePreviewSchema,
  configBundleSchema,
  type ConfigBundle,
  type ConfigBundleImportInput,
  type ConfigBundleImportResult,
  type ConfigBundlePreview,
  type ConfigBundlePreviewInput,
} from '@open-mercato/cezar-api-client'

import { ApiError } from '@/api/client'
import { SID_HEADER, sid } from '@/lib/sid'

/**
 * The configuration bundle routes (spec 2026-11-04-automations-and-config-export-import, Phase 2).
 *
 * Plain `fetch` rather than the typed client: the bundle export answers an attachment the cockpit
 * saves as a file, and every answer is checked against its contract schema here instead.
 */

const BUNDLE_ROUTE = '/workspace/config-bundle'

/** The import routes refuse a body over this (spec §Data Model) — say so before uploading it. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024

async function call(route: string, init: RequestInit = {}): Promise<Response> {
  const url = apiPath(route)
  const headers = new Headers(init.headers)
  headers.set(SID_HEADER, sid())
  try {
    return await fetch(url, { ...init, headers, credentials: 'include' })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the cezar server (${url})`, { cause })
  }
}

async function errorOf(res: Response): Promise<ApiError> {
  const body = await res.text().catch(() => '')
  let message: string | undefined
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed?.error === 'string') message = parsed.error
  } catch {
    // A proxy's HTML page — fall through to the status line.
  }
  return new ApiError(res.status, message ?? `${res.status} ${res.statusText || 'request failed'}`.trim())
}

async function postJson<T>(
  route: string,
  body: unknown,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
): Promise<T> {
  const res = await call(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await errorOf(res)
  const parsed = schema.safeParse(await res.json().catch(() => undefined))
  if (!parsed.success) throw new ApiError(res.status, `the cezar server answered ${route} with an unexpected body`)
  return parsed.data
}

export interface DownloadedBundle {
  blob: Blob
  filename: string
}

/** `GET /workspace/config-bundle` — `projectIds` null exports every registered project. */
export async function exportConfigBundle(projectIds: readonly string[] | null): Promise<DownloadedBundle> {
  const query = projectIds === null ? '' : `?projects=${projectIds.map(encodeURIComponent).join(',')}`
  const res = await call(`${BUNDLE_ROUTE}${query}`)
  if (!res.ok) throw await errorOf(res)
  return { blob: await res.blob(), filename: attachmentName(res.headers.get('content-disposition')) }
}

export function attachmentName(disposition: string | null, now = new Date()): string {
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  if (match?.[1]) return decodeURIComponent(match[1])
  return `cezar-config-${now.toISOString().slice(0, 10)}.json`
}

/** `POST /workspace/config-bundle/preview` — writes nothing. */
export function previewConfigBundle(input: ConfigBundlePreviewInput): Promise<ConfigBundlePreview> {
  return postJson(`${BUNDLE_ROUTE}/preview`, input, configBundlePreviewSchema)
}

/** `POST /workspace/config-bundle/import` — 409 on a stale `planDigest`, 400 on an invalid file. */
export function importConfigBundle(input: ConfigBundleImportInput): Promise<ConfigBundleImportResult> {
  return postJson(`${BUNDLE_ROUTE}/import`, input, configBundleImportResultSchema)
}

export type ParsedBundle = { ok: true; bundle: ConfigBundle } | { ok: false; error: string }

/**
 * Read a picked file as a bundle. One message per failure — the server re-validates everything,
 * this only spares a round trip for a file that is plainly not a bundle (spec §Edge cases).
 */
export function parseConfigBundle(text: string): ParsedBundle {
  if (text.trim() === '') return { ok: false, error: 'this file is empty' }
  if (text.length > MAX_BUNDLE_BYTES) return { ok: false, error: 'this file is larger than 5 MB' }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'this file is not JSON' }
  }
  const parsed = configBundleSchema.safeParse(json)
  if (parsed.success) return { ok: true, bundle: parsed.data }
  // The format check first: "not a bundle" explains a wrong file better than its first odd key.
  const issues = parsed.error.issues
  const issue = issues.find((i) => i.path[0] === 'format') ?? issues.find((i) => i.path[0] === 'version') ?? issues[0]
  const where = issue && issue.path.length > 0 && issue.path[0] !== 'format' && issue.path[0] !== 'version'
    ? ` (at ${issue.path.join('.')})`
    : ''
  return { ok: false, error: `${issue?.message ?? 'not a cezar configuration bundle'}${where}` }
}
