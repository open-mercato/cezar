import { NetworkIcon } from 'lucide-react'
import { useState } from 'react'

import { useHealth, useResetUnitPrompt, useSaveUnitPrompt, useUnitPrompts } from '@/api/queries'
import { CenteredState } from '@/components/centered-state'
import { UnitRoleChip } from '@/components/unit-role-chip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { cn } from '@/lib/utils'
import { UNIT_ROLES, type UnitPrompt, type UnitRole } from '@open-mercato/cezar-api-client'

/**
 * Settings → Units (spec `2026-09-08-units-hierarchy` §Role prompts).
 *
 * A role prompt is the ROLE, shared by every run at that rank — what it is, what it receives, how
 * it delegates, how it reports, and the Guard rule that stops it before anything irreversible.
 * Editing one writes `.ai/cezar/units/<role>.md`; "Restore default" deletes that file, which is
 * why the badge reads `edited` / `default` rather than "saved".
 *
 * Same shape as Prompt templates: edit locally, explicit Save. A PUT per keystroke would be a
 * worse control, not a simpler one — and here it would rewrite a file the next spawned agent
 * reads mid-sentence.
 */
export function UnitsSection() {
  const health = useHealth()
  // The section is only listed when the capability is on (`visibleSettingsSections`), but a
  // pasted `/settings/units` URL still routes here — and every `/units/*` request would 409. So
  // the fetch waits for health's answer and the refusal is rendered as the explainer it is.
  const unitsOn = health.data?.capabilities?.units === true
  const prompts = useUnitPrompts(unitsOn)

  if (health.data === undefined || (unitsOn && prompts.isPending)) {
    return (
      <p data-slot="units-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading role prompts…
      </p>
    )
  }
  if (!unitsOn) {
    return (
      <CenteredState
        icon={<NetworkIcon />}
        tone="neutral"
        title="Missions are off"
        subtitle="This server runs flat tasks only. Set CEZ_UNITS=1 and restart cezar to let a task command a tree of agents."
        heading="h2"
      />
    )
  }
  if (prompts.isError) {
    return (
      <CenteredState
        icon={<NetworkIcon />}
        tone="danger"
        title="Role prompts did not load"
        subtitle={prompts.error.message}
        heading="h2"
      />
    )
  }
  return <UnitsForm prompts={prompts.data?.prompts ?? []} />
}

function UnitsForm({ prompts }: { prompts: readonly UnitPrompt[] }) {
  const [role, setRole] = useState<UnitRole>('caesar')
  // The local edit, per role, keyed so switching roles keeps an unsaved draft rather than
  // silently discarding it — a prompt is long enough that losing one to a stray click is a real
  // cost. A role with no entry here is showing exactly what the server answered.
  const [drafts, setDrafts] = useState<Partial<Record<UnitRole, string>>>({})
  const [confirmingReset, setConfirmingReset] = useState(false)

  const save = useSaveUnitPrompt()
  const restore = useResetUnitPrompt()

  const entryFor = (id: UnitRole): UnitPrompt | undefined => prompts.find((p) => p.role === id)
  const selected = entryFor(role)
  const text = drafts[role] ?? selected?.text ?? ''
  const dirty = selected !== undefined && text !== selected.text

  const clearDraft = (id: UnitRole) =>
    setDrafts((current) => {
      const { [id]: _dropped, ...rest } = current
      return rest
    })

  return (
    <div
      data-slot="units-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <section className="flex flex-col gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Role prompts</h2>
          <p className="text-[13px] text-muted-foreground">
            What each rank is told about itself before it reads its task order. An edit is saved to
            this repo (<code className="font-mono text-[12px]">.ai/cezar/units/&lt;role&gt;.md</code>
            ); restoring the default deletes that file.
          </p>
        </div>

        <div data-slot="unit-role-list" className="flex flex-col gap-1.5">
          {UNIT_ROLES.map((id) => {
            const entry = entryFor(id)
            const edited = entry?.source === 'file'
            return (
              <button
                key={id}
                type="button"
                data-slot="unit-role-row"
                data-role={id}
                data-selected={role === id ? 'true' : undefined}
                aria-pressed={role === id}
                onClick={() => setRole(id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-muted',
                  role === id && 'border-primary bg-primary/5 hover:bg-primary/5',
                )}
              >
                <UnitRoleChip role={id} />
                <span
                  data-slot="unit-prompt-source"
                  className="ml-auto rounded-full border border-border px-2 py-px text-[11px] font-medium text-muted-foreground"
                >
                  {edited ? 'edited' : 'default'}
                </span>
                {drafts[id] !== undefined && drafts[id] !== entry?.text ? (
                  <span data-slot="unit-prompt-dirty" className="text-[11px] text-pending-strong">
                    unsaved
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <Textarea
          aria-label={`System prompt for the ${role} role`}
          data-slot="unit-prompt-editor"
          data-role={role}
          value={text}
          maxLength={40_000}
          onChange={(event) => setDrafts((current) => ({ ...current, [role]: event.target.value }))}
          className="min-h-64 font-mono text-[12.5px]"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="contrast"
            size="sm"
            data-action="unit-prompt-save"
            disabled={!dirty || text.trim() === '' || save.isPending}
            onClick={() =>
              save.mutate(
                { role, text },
                {
                  onSuccess: () => {
                    clearDraft(role)
                    toast('Role prompt saved')
                  },
                  onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                },
              )
            }
          >
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="unit-prompt-restore"
            // Only offered where there is something to restore: on a role still running the
            // shipped prompt, "Restore default" would delete a file that does not exist.
            disabled={selected?.source !== 'file' || restore.isPending}
            onClick={() => setConfirmingReset(true)}
          >
            Restore default
          </Button>
          {dirty ? (
            <p data-slot="unit-prompt-unsaved" className="text-[11px] text-soft-foreground">
              Unsaved changes.
            </p>
          ) : null}
        </div>
      </section>

      {/* The design-system dialog, never native confirm(): restoring throws away an edit that
          only exists in this repo's file. */}
      <AlertDialog open={confirmingReset} onOpenChange={setConfirmingReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore the shipped {role} prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes this repo’s override for that rank and puts cezar’s own prompt back.
              There is no undo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the edit</AlertDialogCancel>
            <AlertDialogAction
              data-action="unit-prompt-restore-confirm"
              className="bg-danger text-danger-foreground hover:brightness-[0.96]"
              onClick={() => {
                setConfirmingReset(false)
                restore.mutate(role, {
                  onSuccess: () => {
                    clearDraft(role)
                    toast('Default role prompt restored')
                  },
                  onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                })
              }}
            >
              Restore default
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
