import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useHealth } from '@/api/queries'
import { getTerminalCommands, setTerminalCommands } from '@/api/client'
import type { StartAppScope, TerminalCommand, TerminalCommandsState } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SettingsCard } from './form-row'

const MAX_COMMANDS = 30

const SCOPES: Array<{ scope: StartAppScope; title: string; detail: string }> = [
  { scope: 'project', title: 'Team', detail: "Saved in the repo's .ai/cezar/config.json. Commit it and everyone gets the same commands." },
  { scope: 'personal', title: 'Only me', detail: 'Saved in your ~/.cezar/config.json, listed before the team commands.' },
]

/**
 * Settings → Terminal commands (#1555): named run commands for the task terminal's picker. They
 * are offered beside the ones detected from `package.json` / a Makefile — never instead of them —
 * and run in the task's worktree like any typed command. Team and personal lists are edited
 * separately, as the start recipe's are.
 */
export function TerminalCommandsSection() {
  const health = useHealth()
  const terminalOn = health.data?.capabilities.terminal !== false
  const [state, setState] = useState<TerminalCommandsState | null>(null)
  const [scope, setScope] = useState<StartAppScope>('project')
  const [rows, setRows] = useState<TerminalCommand[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getTerminalCommands()
      .then((loaded) => {
        if (cancelled) return
        setState(loaded)
        const initial: StartAppScope = loaded.personal.length > 0 ? 'personal' : 'project'
        setScope(initial)
        setRows(loaded[initial])
      })
      .catch((cause: unknown) => !cancelled && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => {
      cancelled = true
    }
  }, [])

  const edit = (at: number, patch: Partial<TerminalCommand>) => {
    setSaved(false)
    setRows((current) => current.map((row, index) => (index === at ? { ...row, ...patch } : row)))
  }
  const move = (at: number, by: -1 | 1) => {
    setSaved(false)
    setRows((current) => {
      const next = [...current]
      const [row] = next.splice(at, 1)
      next.splice(at + by, 0, row!)
      return next
    })
  }

  // A half-filled row is dropped on save rather than refused: the form is a list to tidy, not a
  // set of required fields.
  const cleaned = rows
    .map((row) => ({ name: row.name.trim(), command: row.command.trim() }))
    .filter((row) => row.name !== '' && row.command !== '')
  const dirty = JSON.stringify(cleaned) !== JSON.stringify(state?.[scope] ?? [])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = await setTerminalCommands({ scope, commands: cleaned })
      setState(next)
      setRows(next[scope])
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Terminal commands"
      description="Named commands for the task terminal's menu, shown beside the ones found in package.json and a Makefile. They run in the task's worktree."
      slot="terminal-commands"
    >
      <div className="flex flex-col gap-4 p-4">
        {terminalOn ? null : (
          <p className="text-label text-muted-foreground">The terminal is off on this cockpit, so commands cannot be saved.</p>
        )}
        <div role="radiogroup" aria-label="Who uses these commands" className="grid grid-cols-2 gap-2">
          {SCOPES.map((entry) => {
            const disabled = entry.scope === 'personal' && state?.personalAvailable === false
            const selected = scope === entry.scope
            return (
              <button
                key={entry.scope}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => {
                  setScope(entry.scope)
                  setRows(state?.[entry.scope] ?? [])
                  setSaved(false)
                }}
                className={cn(
                  'flex flex-col gap-1 rounded-md border p-2.5 text-left text-xs transition-colors disabled:opacity-50',
                  selected ? 'border-foreground/40 bg-muted' : 'border-border hover:bg-muted/50',
                )}
              >
                <span className="font-medium text-foreground">
                  {entry.title}
                  {(state?.[entry.scope].length ?? 0) > 0 ? (
                    <span className="ml-1.5 font-normal text-muted-foreground">· {state?.[entry.scope].length} saved</span>
                  ) : null}
                </span>
                <span className="text-muted-foreground">
                  {disabled ? 'This project is not in your project list.' : entry.detail}
                </span>
              </button>
            )
          })}
        </div>

        <ul className="flex flex-col gap-1.5" aria-label="Commands">
          {rows.map((row, index) => (
            <li key={index} className="flex items-center gap-1.5">
              <Input
                value={row.name}
                onChange={(event) => edit(index, { name: event.target.value })}
                placeholder="Name"
                aria-label={`Name of command ${index + 1}`}
                maxLength={80}
                className="h-8 w-40 shrink-0 text-xs md:text-xs"
              />
              <Input
                value={row.command}
                onChange={(event) => edit(index, { command: event.target.value })}
                placeholder="pnpm dev"
                aria-label={`Command line ${index + 1}`}
                maxLength={500}
                spellCheck={false}
                className="h-8 min-w-0 flex-1 font-mono text-xs md:text-xs"
              />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move command ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUpIcon aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move command ${index + 1} down`} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                <ArrowDownIcon aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove command ${index + 1}`} onClick={() => { setSaved(false); setRows((current) => current.filter((_, at) => at !== index)) }}>
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
        {rows.length === 0 ? (
          <p className="text-label text-muted-foreground">
            None yet. The terminal menu still offers what it finds in package.json and a Makefile.
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={rows.length >= MAX_COMMANDS}
            onClick={() => { setSaved(false); setRows((current) => [...current, { name: '', command: '' }]) }}
          >
            <PlusIcon aria-hidden="true" />
            Add command
          </Button>
          <span className="flex-1" />
          {saved ? <span className="text-label text-muted-foreground">Saved</span> : null}
          <Button type="button" disabled={saving || !dirty || !terminalOn} onClick={() => void save()}>
            Save
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-label text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsCard>
  )
}

