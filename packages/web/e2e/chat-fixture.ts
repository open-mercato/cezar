import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chatControlFile } from './chat-control'
import type { E2EConfig } from 'e2e'
import { web } from '@e2e-dev/web'

export type FixtureProvider = 'slack' | 'discord'

/** `<provider>-<suite>.config.ts`: the shared `chat-<suite>.e2e.ts` against one simulated provider. */
export function chatFixtureConfig(suite: string, provider: FixtureProvider) {
  const name = `${provider}-${suite}`
  return {
    tests: `./chat-${suite}.e2e.ts`, workers: 1, timeout: 90_000, assertionTimeout: 15_000,
    output: `.e2e/${name}`,
    targets: [{ engine: web({ viewport: { width: 1280, height: 1000 } }), app: {
      url: 'http://127.0.0.1:0', readyUrl: 'http://127.0.0.1:{port}/api/v1/health',
      command: { executable: process.execPath, args: ['--import', 'tsx', resolve(import.meta.dirname, 'slack-discord-server.mjs')], env: { LD_PRELOAD: process.env.LD_PRELOAD ?? '', PORT: '{port}', FIXTURE_PROVIDER: provider }, startupTimeout: 120_000, log: `.e2e/${name}/app.log` },
    } }],
  } satisfies E2EConfig
}

/** What differs between the simulated providers; every flow is otherwise the same. */
const profiles = {
  slack: {
    name: 'Slack',
    credentials: [['App-level token', 'xapp-fixture-app-token'], ['Bot token', 'xoxb-fixture-bot-token']],
    privateCommand: 'Setup command', groupCommand: 'Setup command',
    privateChatId: 'private:T1:U1:D1', groupChatId: 'group:T1:U1:C1', groupChannel: 'C1',
    taskCommand: 'cezar task ', groupTaskCommand: '<@U1> cezar task ', completed: /Task completed/i,
    // Upgrade the webhook from its own row; Discord covers the Connect chooser route to the same upgrade.
    upgradeThroughChooser: false,
  },
  discord: {
    name: 'Discord',
    credentials: [['Bot token', 'a'.repeat(24) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(27)]],
    privateCommand: 'Command for private chat', groupCommand: 'Command for group or channel',
    privateChatId: 'discord:dm:100000000000000003', groupChatId: 'discord:guild:100000000000000005:100000000000000004', groupChannel: '100000000000000004',
    taskCommand: '/task ', groupTaskCommand: '<@100000000000000001> /task ', completed: /^Completed\n/,
    upgradeThroughChooser: true,
  },
} as const

/** The simulator's control port, published once its listener is up (see slack-discord-server.mjs). */
async function controlPort(appPort: string): Promise<number> {
  const file = chatControlFile(appPort)
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await new Promise(done => setTimeout(done, 100))) {
    try { return (JSON.parse(readFileSync(file, 'utf8')) as { port: number }).port } catch { /* not published yet */ }
  }
  throw new Error(`The chat simulator never published its control port (${file})`)
}

/** The simulator's control channel and the provider it simulates. */
export async function chatFixture(baseUrl: string | undefined) {
  if (!baseUrl) throw new Error('Missing fixture URL')
  const base = baseUrl.replace(/\/$/, '')
  const control = new URL(base); control.port = String(await controlPort(control.port))
  const fixture = async (path = '/', data?: unknown) => {
    const response = await fetch(new URL(path, control), data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) })
    if (!response.ok) throw new Error(await response.text())
    return response.json()
  }
  const receivers = async () => (await fetch(base + '/api/v1/webhooks').then(r => r.json())).receivers
  const initial = await fixture()
  const provider = initial.provider as FixtureProvider
  return { base, fixture, receivers, initial, provider, profile: profiles[provider] }
}
