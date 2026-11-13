import { expect, it } from 'vitest'
import { extensionRecordSchema, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { keepsConsent } from './consent.ts'

const record = (manifest: Record<string, unknown>, enabled = true): ExtensionRecord => extensionRecordSchema.parse({
  manifest: { id: 'probe', name: 'Probe', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs', capabilities: [], ...manifest },
  source: './probe', installedAt: '2026-11-06T00:00:00.000Z', enabled,
})

it('asks again for an added capability or permission, keeps consent otherwise', () => {
  const old = record({ capabilities: ['commands', 'panels'] })
  expect(keepsConsent(old, record({ capabilities: ['commands'] }))).toBe(true)
  expect(keepsConsent(old, record({ capabilities: ['commands', 'taskEvents'] }))).toBe(false)
  expect(keepsConsent(old, record({ capabilities: ['commands'], permissions: ['project.read'] }))).toBe(false)
})

it('keeps an approval that asks for nothing new and never resumes a disabled one', () => {
  expect(keepsConsent(record({ capabilities: ['commands', 'panels'] }), record({ capabilities: ['commands'] }))).toBe(true)
  expect(keepsConsent(record({}, false), record({}))).toBe(false)
  expect(keepsConsent(undefined, record({}))).toBe(false)
})

it('asks again when the same id comes from a different source ', () => {
  const old = record({})
  expect(keepsConsent(old, { ...record({}), source: './fork' })).toBe(false)
  expect(keepsConsent({ ...old, source: 'pkg' }, { ...record({}), source: 'pkg@2.0.0' })).toBe(true)
  expect(keepsConsent({ ...old, source: 'pkg' }, { ...record({}), source: 'other-pkg' })).toBe(false)
})
it('requires fresh consent when adding the host credential profile', () => {
 const provider={id:'chat',label:'Chat',credentials:[{name:'token',label:'Token'}],discoveryUrl:'https://example.com',limits:{maxText:1000,buttonsPerMessage:0,perChatPerSecond:1,perBotPerSecond:1},receiveModel:'ordered'}
 const old=record({capabilities:['chatProviders'],contributes:{chatProviders:[provider]}})
 const next=record({capabilities:['chatProviders'],contributes:{chatProviders:[{...provider,credentialProfile:'slack-oauth-v1'}]}})
 expect(keepsConsent(old,next)).toBe(false)
 expect(keepsConsent(next,next)).toBe(true)
})
it('requires fresh consent when an update changes the receive model', () => {
 const provider={id:'chat',label:'Chat',credentials:[{name:'token',label:'Token'}],discoveryUrl:'https://example.com',limits:{maxText:1000,buttonsPerMessage:0,perChatPerSecond:1,perBotPerSecond:1}}
 const chat=(extra:Record<string,unknown>)=>record({capabilities:['chatProviders'],contributes:{chatProviders:[{...provider,...extra}]}})
 expect(keepsConsent(chat({receiveModel:'ordered'}),chat({receiveModel:'opaque'}))).toBe(false)
 expect(keepsConsent(chat({receiveModel:'ordered'}),chat({receiveModel:'ordered'}))).toBe(true)
})
