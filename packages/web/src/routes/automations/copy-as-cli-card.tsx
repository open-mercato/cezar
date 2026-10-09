import { CopyIcon } from 'lucide-react'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { cliOf, type CliDefinition } from '@/lib/automation-cli'

import { copyText } from './use-automations'

/**
 * "Copy as CLI" (spec 2026-09-14-automations-redesign Q1, § UI/UX 4): the `cez automation add`
 * flag form of what the form holds when the definition is expressible in flags, the JSON
 * `create` form otherwise — the same body the Save button sends, so the line recreates exactly
 * what the cockpit would store.
 */
export function CopyAsCliCard({ definition }: { definition: CliDefinition }) {
  const line = useMemo(() => cliOf(definition), [definition])
  return (
    <section data-slot="copy-as-cli">
      <div className="mb-2 flex items-center">
        <h2 className="text-[15px] font-semibold">Copy as CLI</h2>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void copyText(line)}>
          <CopyIcon aria-hidden="true" />
          Copy
        </Button>
      </div>
      <pre className="m-0 rounded-lg bg-muted/60 px-3 py-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
        {line}
      </pre>
      <p className="mt-2 mb-0 text-xs leading-relaxed text-pretty text-muted-foreground">
        The same definition the cockpit saves — <code className="text-[11px]">cez automation schema</code> prints its shape.
      </p>
    </section>
  )
}
