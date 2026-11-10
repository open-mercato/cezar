import { InfoIcon } from 'lucide-react'

/** `task.waitForPrevious` (#1801): one launch at a time per automation. Off by default. */
export const WAIT_FOR_PREVIOUS_HINT =
  'For longer tasks it is safer to let the previous run finish before another one starts. While a run is queued, running or waiting, a schedule holds the overlapping occurrence and launches one catch-up once that run settles (several missed occurrences collapse into one); a GitHub or tracker poll holds its matches and launches them once it settles. Runs at the review gate count as finished.'

export function EditorWaitForPreviousRow({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div data-slot="editor-wait-for-previous" className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
      <label className="flex items-center gap-2 text-ui font-medium text-foreground">
        <input
          type="checkbox"
          className="size-3.5 accent-violet"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        Wait for the previous execution to finish before starting a new one
      </label>
      <p data-slot="editor-wait-for-previous-hint" className="m-0 flex items-start gap-1.5 pl-5.5 text-label text-soft-foreground">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {WAIT_FOR_PREVIOUS_HINT}
      </p>
    </div>
  )
}
