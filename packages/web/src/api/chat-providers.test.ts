import { afterEach, expect, it, vi } from 'vitest'
import * as client from './client'
import { chatProviderDescriptors } from '@/lib/chat-providers'
afterEach(() => vi.unstubAllGlobals())
it.each(['slack', 'discord'] as const)('%s binds scoped setup and workspace recovery independently of Telegram', async provider => {
 const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })))
 vi.stubGlobal('fetch', fetch)
 const api = client[provider === 'slack' ? 'slackApi' : 'discordApi']
 expect(api).toBeDefined()
 const descriptor = chatProviderDescriptors.find(item => item.id === provider)!
 expect(descriptor.bot?.api).toBe(api)
 await descriptor.bot!.setupApi.begin('other-project', { token: 'synthetic', dedicatedBot: true, name: 'test', receiverId: 'existing', expectedRevision: 'revision' })
 let [url, init] = fetch.mock.calls.at(-1)!
 expect(url).toContain('/api/v1/p/other-project/' + provider + '/setup')
 expect(JSON.parse(init.body)).toMatchObject({ receiverId: 'existing', expectedRevision: 'revision' })
 await api.bindings()
 expect(fetch.mock.calls.at(-1)![0]).toContain('/api/v1/' + provider + '/bot-bindings')
 await api.releaseBinding('12345', 'revision')
 ;[url, init] = fetch.mock.calls.at(-1)!
 expect(url).toContain('/api/v1/' + provider + '/bot-bindings/12345')
 expect(url).toContain('confirmOrphanRelease=true')
 expect(init.method).toBe('DELETE')
})
