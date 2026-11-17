import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { writeClipboard } from '@/lib/clipboard'

export function CopySetupValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    setCopied(false)
    return () => { generation.current++; clearTimeout(timer.current) }
  }, [value])
  const copy = async () => {
    const attempt = ++generation.current
    clearTimeout(timer.current)
    setCopied(false)
    try {
      await writeClipboard(value)
      if (attempt !== generation.current) return
      setCopied(true)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      if (attempt === generation.current) toast('Copy failed — select the value and copy it manually.', { tone: 'danger' })
    }
  }
  return <span className="inline-flex">
    <Button type="button" size="sm" variant="outline" title={copied ? 'Copied' : label} onClick={() => void copy()}>
      {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}{label}
    </Button>
    <span role="status" className="sr-only">{copied ? 'Copied' : ''}</span>
  </span>
}

// Slack's manifest configures the otherwise easy-to-miss inbound events and writable App Home.
export const slackAppManifest = JSON.stringify({
  display_information: { name: 'Cezar', description: 'Task notifications and conversations with Cezar' },
  features: { slash_commands: [{ command: '/cezar', description: 'List tasks or check their status', usage_hint: 'tasks | status [task ID] | help', should_escape: false }], bot_user: { display_name: 'Cezar', always_online: false }, app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
  oauth_config: { scopes: { bot: ['commands', 'chat:write', 'app_mentions:read', 'channels:read', 'channels:history', 'groups:read', 'groups:history', 'im:read', 'im:history', 'mpim:read', 'mpim:history'] } },
  settings: { socket_mode_enabled: true, interactivity: { is_enabled: true }, event_subscriptions: { bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'member_left_channel'] } },
}, null, 2)

const slackCreateAppUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(JSON.parse(slackAppManifest)))}`

export function ChatSetupHelp({ providerId, connecting = false, help }: { providerId: string; connecting?: boolean; help?: { label: string; href: string } }) {
  if (providerId === 'telegram') return null
  if (providerId !== 'slack' && providerId !== 'discord') return <div className="rounded-md border p-3 text-sm">
    <h3 className="font-medium">{connecting ? 'No message received?' : `Prepare your ${help?.label ?? 'chat provider'}`}</h3>
    {connecting ? <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li>Send the current setup command shown above to the bot in the intended conversation.</li>
      <li>Check that the bot can read and send messages there. For a group, add the bot and address it as required by your provider.</li>
      <li>Check the extension’s connection status and credentials. If the setup code expired, restart setup and use the new command.</li>
    </ol> : <p className="mt-2">Create a dedicated bot using your provider’s instructions, grant it access to the intended conversations, and enter its credentials below.</p>}
    {help && <a className="mt-2 inline-block underline" href={help.href} target="_blank" rel="noreferrer">{help.label} setup documentation</a>}
  </div>
  if (connecting) return <details className="rounded-md border p-3 text-sm"><summary className="cursor-pointer font-medium">No message received? Check these steps</summary>
    {providerId === 'slack' ? <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li>Open the app in Slack → Messages. If Messages is missing, enable it in App Home and allow users to send messages.</li>
      <li>In Slack app settings, enable Socket Mode and Event Subscriptions. Subscribe to message.im for direct messages and app_mention for channels. Save and reinstall the app if Slack asks.</li>
      <li>For a channel, invite the bot first and select it from the @ picker before the command. Send a new message using the current code.</li>
    </ol> : <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li>Use “Add to a group” to invite the bot to a server you belong to. The invite already includes the required permissions.</li>
      <li>Open the bot from that server’s member list → Message. Allow direct messages in the server’s privacy settings. A rejection by Clyde means Discord did not deliver your message.</li>
      <li>In Developer Portal → Bot, enable Message Content Intent. Leave Interactions Endpoint URL empty. If you changed these settings, cancel and restart setup.</li>
      <li>Alternatively, send the channel command in a text channel the bot can view and send messages in.</li>
    </ol>}
    <a className="mt-2 inline-block underline" href={providerId === 'slack' ? 'https://api.slack.com/apps' : 'https://discord.com/developers/applications'} target="_blank" rel="noreferrer">Open app settings</a>
  </details>
  return <div className="rounded-md border p-3 text-sm">
    <h3 className="font-medium">Prepare your {providerId === 'slack' ? 'Slack app' : 'Discord bot'}</h3>
    {providerId === 'slack' ? <>
      <ol className="my-2 list-decimal space-y-2 pl-5">
        <li><a className="underline" href={slackCreateAppUrl} target="_blank" rel="noreferrer">Create a preconfigured Slack app</a>. Choose your workspace and review the settings. Cezar fills in messages, the /cezar command, events, permissions and Socket Mode for you. If Slack asks you to paste a manifest, use the copy button below.</li>
        <li>Open Features → OAuth &amp; Permissions → OAuth Tokens for Your Workspace. If no token is shown, click Install to Workspace and then Allow. Copy the Bot User OAuth Token (xoxb-… or xoxe.xoxb-…) into Bot token below.</li>
        <li>In Basic Information → App-Level Tokens, generate a token with connections:write and paste its Access token into App-level token below. If Slack also shows a Refresh token, keep this window open: Cezar will show you where to paste it for automatic renewal.</li>
      </ol>
      <CopySetupValue value={slackAppManifest} label="Copy Slack manifest" />
      <details className="mt-2"><summary className="cursor-pointer">Show manifest</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{slackAppManifest}</pre></details>
      <p className="mt-2 text-muted-foreground">Already have an app? Apply these settings in App Manifest, save, and reinstall if Slack requests it.</p>
    </> : <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li><a className="underline" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Open Discord Developer Portal</a> → New Application → Bot.</li>
      <li>Enable Message Content Intent under Privileged Gateway Intents. Leave Interactions Endpoint URL empty.</li>
      <li>Copy the bot token into the field below. Reset Token if Discord no longer shows it.</li>
      <li>Next, Cezar generates your server invitation with the required permissions. You do not need Administrator or a separate webhook.</li>
    </ol>}
  </div>
}
