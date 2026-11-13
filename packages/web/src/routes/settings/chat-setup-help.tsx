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

export function ChatSetupHelp({ providerId, connecting = false, help }: { providerId: string; connecting?: boolean; help?: { label: string; href: string } }) {
  if (providerId === 'telegram') return null
  return <div className="rounded-md border p-3 text-sm">
    <h3 className="font-medium">{connecting ? 'No message received?' : `Prepare your ${help?.label ?? 'chat provider'}`}</h3>
    {connecting ? <ol className="mt-2 list-decimal space-y-2 pl-5">
      <li>Send the current setup command shown above to the bot in the intended conversation.</li>
      <li>Check that the bot can read and send messages there. For a group, add the bot and address it as required by your provider.</li>
      <li>Check the extension’s connection status and credentials. If the setup code expired, restart setup and use the new command.</li>
    </ol> : <p className="mt-2">Create a dedicated bot using your provider’s instructions, grant it access to the intended conversations, and enter its credentials below.</p>}
    {help && <a className="mt-2 inline-block underline" href={help.href} target="_blank" rel="noreferrer">{help.label} setup documentation</a>}
  </div>
}
