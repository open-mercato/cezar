import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatSetupHelp, slackAppManifest } from './chat-setup-help'
import { ChatDiscoveryCommand } from './chat-discovery-command'
import { createDiscordDescriptor } from '@/lib/chat-providers/discord'
import { Toaster, resetToasts } from '@/components/ui/toaster'
const clipboard = vi.hoisted(() => vi.fn())
vi.mock('@/lib/clipboard', () => ({ writeClipboard: clipboard }))
afterEach(() => { cleanup(); resetToasts(); vi.resetAllMocks() })
it('copies a Slack manifest with writable DMs, inbound events and Socket Mode configured', async () => {
  clipboard.mockResolvedValue(undefined)
  render(<ChatSetupHelp providerId="slack" />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy Slack manifest' }))
  await screen.findByText('Copied')
  expect(clipboard).toHaveBeenCalledWith(slackAppManifest)
  const creation = new URL(screen.getByRole('link', { name: 'Create a preconfigured Slack app' }).getAttribute('href')!)
  expect(JSON.parse(creation.searchParams.get('manifest_json')!)).toEqual(JSON.parse(slackAppManifest))
  const manifest = JSON.parse(slackAppManifest)
  expect(manifest.features.app_home).toMatchObject({ messages_tab_enabled: true, messages_tab_read_only_enabled: false })
  expect(manifest.features.slash_commands).toContainEqual(expect.objectContaining({ command: '/cezar', usage_hint: 'tasks | status [task ID] | help' }))
  expect(manifest.oauth_config.scopes.bot).toContain('commands')
  expect(manifest.settings.socket_mode_enabled).toBe(true)
  expect(manifest.settings.event_subscriptions.bot_events).toEqual(expect.arrayContaining(['message.im', 'app_mention', 'member_left_channel']))
})
it('copies the exact Discord discovery command and retains manual fallback on failure', async () => {
  clipboard.mockRejectedValue(new Error('denied'))
  const provider = createDiscordDescriptor({} as never)
  render(<><ChatDiscoveryCommand provider={provider} link="https://discord.com/users/123456789#cezar-start=example-code" /><Toaster /></>)
  fireEvent.click(screen.getByRole('button', { name: 'Copy command for private chat' }))
  await waitFor(() => expect(screen.getByText(/Copy failed — select the value/)).toBeTruthy())
  expect(clipboard).toHaveBeenCalledWith('/start example-code')
  expect(screen.getByLabelText('Command for private chat')).toHaveProperty('value', '/start example-code')
})
