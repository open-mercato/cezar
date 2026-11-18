import { hc, type InferRequestType, type InferResponseType } from 'hono/client'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  extensionActionResponseSchema,
  extensionInventoryResponseSchema,
  extensionUninstallImpactSchema,
  extensionInvokeInputSchema,
  extensionManifestSchema,
  extensionMutationResponseSchema,
  extensionErrorResponseSchema,
  extensionFormsResponseSchema,
  extensionPanelQuerySchema,
  extensionPanelSchema,
  extensionPlacementsQuerySchema,
  extensionPlacementsResponseSchema,
  extensionPrepareInstallResponseSchema,
  extensionRecordSchema,
} from '@open-mercato/cezar-contract'
import type { AppType } from './app-type.ts'

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider'
type Assert<T extends true> = T
const client = hc<AppType>('http://127.0.0.1')
const extensions = client.api.v1.p[':projectId'].extensions
const extensionInvoke = extensions[':extensionId'].commands[':commandId'].invoke
const extensionPanel = extensions[':extensionId'].panels[':panelId']
const extensionForms = extensions[':extensionId'].forms
const extensionPlacements = extensions.placements
const globalExtensions = client.api.v1.extensions
const extensionDelete = globalExtensions[':extensionId']

type Checks = [
  Assert<Mutual<z.infer<typeof extensionInventoryResponseSchema>, InferResponseType<typeof extensions.inventory.$get, 200>>>,
  Assert<Mutual<z.infer<typeof extensionUninstallImpactSchema>, InferResponseType<typeof globalExtensions[':extensionId']['uninstall-impact']['$get'], 200>>>,
  Assert<Mutual<z.infer<typeof extensionPanelSchema>, InferResponseType<typeof extensionPanel.$get, 200>>>,
  // Placements: the response, the `location` query, the panel `runId` query and the invoke body.
  Assert<Mutual<z.infer<typeof extensionPlacementsResponseSchema>, InferResponseType<typeof extensionPlacements.$get, 200>>>,
  Assert<Mutual<z.infer<typeof extensionPlacementsQuerySchema>, InferRequestType<typeof extensionPlacements.$get>['query']>>,
  Assert<Mutual<z.infer<typeof extensionPanelQuerySchema>, InferRequestType<typeof extensionPanel.$get>['query']>>,
  Assert<Mutual<z.infer<typeof extensionInvokeInputSchema>, InferRequestType<typeof extensionInvoke.$post>['json']>>,
  Assert<Mutual<z.infer<typeof extensionErrorResponseSchema>, InferResponseType<typeof extensionInvoke.$post, 404>>>,
  Assert<Mutual<z.infer<typeof extensionFormsResponseSchema>, InferResponseType<typeof extensionForms.$get, 200>>>,
  Assert<Mutual<z.infer<typeof extensionErrorResponseSchema>, InferResponseType<typeof extensionForms.$get, 400>>>,
  Assert<Mutual<z.infer<typeof extensionErrorResponseSchema>, InferResponseType<typeof extensionPanel.$get, 400>>>,
  Assert<Mutual<z.infer<typeof extensionErrorResponseSchema>, InferResponseType<typeof extensionPanel.$get, 404>>>,
  Assert<Mutual<z.infer<typeof extensionPrepareInstallResponseSchema>, InferResponseType<typeof globalExtensions['prepare-install']['$post'], 200>>>,
  Assert<Mutual<z.infer<typeof extensionRecordSchema>, InferResponseType<typeof globalExtensions['commit-install']['$post'], 201>>>,
  Assert<Mutual<z.infer<typeof extensionActionResponseSchema>, InferResponseType<typeof extensionInvoke.$post, 200>>>,
  Assert<Mutual<z.infer<typeof extensionMutationResponseSchema>, InferResponseType<typeof extensionDelete.$delete, 200>>>,
]
const checked: Checks | undefined = undefined
void checked

describe('extension HTTP contract parity', () => {
  it('keeps the extension manifest schema usable at runtime', () => {
    expect(extensionManifestSchema.parse({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [] }).permissions).toEqual([])
  })
  it('keeps the placements response strict and the run id bounded', () => {
    expect(extensionPlacementsResponseSchema.parse({ available: false, extensions: [] })).toEqual({ available: false, extensions: [] })
    expect(extensionPlacementsResponseSchema.safeParse({ available: true, extensions: [{ extensionId: 'x', name: 'X', status: 'running', panels: [], commands: [], extra: 1 }] }).success).toBe(false)
    expect(extensionPanelQuerySchema.safeParse({ runId: '../x' }).success).toBe(false)
    expect(extensionInvokeInputSchema.parse({ runId: 'abc-123' })).toEqual({ runId: 'abc-123' })
    expect(extensionPlacementsQuerySchema.safeParse({ location: 'toolbar' }).success).toBe(false)
  })
})
