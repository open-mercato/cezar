import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatDiscoveryCommand } from '../../../routes/settings/chat-discovery-command'
import { createSlackDescriptor } from './index'
const provider = createSlackDescriptor({ api: {} as never, setupApi: {} as never, subscribe: () => () => {} })
const link = 'https://app.slack.com/client/TTEAM/UREALBOT?cezar_start=CODE'

it('renders only the copyable command and tells the user to select the installed bot before pasting', () => {
 render(<><p>{provider.bot.discoveryHint}</p><ChatDiscoveryCommand provider={provider} link={link} group /></>)
 const command = (screen.getByRole('textbox', { name: 'Command for group or channel' }) as HTMLInputElement).value
 expect(command).toBe('cezar start CODE')
 expect(screen.getByText(provider.bot.discoveryHint!).textContent).toContain('select the installed bot from Slack’s @ picker')
 expect(provider.bot.discoveryHint).toContain('paste')

})

it('keeps the private discovery command directly usable', () => {
 render(<ChatDiscoveryCommand provider={provider} link={link} />)
 const command = (screen.getByRole('textbox', { name: 'Command for private chat' }) as HTMLInputElement).value
 expect(command).toBe('cezar start CODE')
})
