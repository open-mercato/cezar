import { ATTENTION_KINDS, type AttentionKind, type PhonePushPrefs } from '@open-mercato/cezar-api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { attentionKeys, getMyPushPrefs, setMyPushPrefs } from '@/api/attention'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/components/ui/toaster'
import { CardNote, FormRow, SettingsCard, useSavedFlash } from './form-row'

/**
 * One phone's notification settings (spec 2026-11-20-phone-notifications-inbox): which kinds push,
 * which count on the icon, quiet hours. Kept on the computer, because the relay never learns a kind.
 */

export const KIND_TITLE: Record<AttentionKind, string> = {
  question: 'Questions',
  approval: 'Approvals',
  task: 'Tasks that need me',
  review: 'Tasks ready for review',
  failed: 'Failed tasks',
  message: 'Important manager messages',
}

const toggle = (kinds: readonly AttentionKind[], kind: AttentionKind, on: boolean): AttentionKind[] =>
  ATTENTION_KINDS.filter((each) => (each === kind ? on : kinds.includes(each)))

const localTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The form alone: the phone's own page and the computer's per-phone row both render it. */
export function PhoneNotificationsForm({
  value,
  onChange,
  saved = false,
  idPrefix,
  timeZone = localTimeZone(),
}: {
  value: PhonePushPrefs
  onChange: (next: PhonePushPrefs) => void
  saved?: boolean
  idPrefix: string
  /** Where quiet hours start out: this browser's zone, which on the phone is the phone's own. */
  timeZone?: string | undefined
}) {
  const quiet = value.quiet
  return (
    <div data-slot="phone-notifications-form" className="flex flex-col">
      <p className="px-4 pt-3 pb-1 text-label font-medium text-muted-foreground">Push me for</p>
      {ATTENTION_KINDS.map((kind) => (
        <FormRow key={`push-${kind}`} label={KIND_TITLE[kind]} htmlFor={`${idPrefix}-push-${kind}`} saved={saved && kind === ATTENTION_KINDS[0]}>
          <Switch
            id={`${idPrefix}-push-${kind}`}
            data-slot="phone-push-kind"
            data-kind={kind}
            checked={value.push.includes(kind)}
            onCheckedChange={(on) => onChange({ ...value, push: toggle(value.push, kind, on) })}
          />
        </FormRow>
      ))}
      <p className="px-4 pt-4 pb-1 text-label font-medium text-muted-foreground">Count on the app icon</p>
      {ATTENTION_KINDS.map((kind) => (
        <FormRow key={`badge-${kind}`} label={KIND_TITLE[kind]} htmlFor={`${idPrefix}-badge-${kind}`}>
          <Switch
            id={`${idPrefix}-badge-${kind}`}
            data-slot="phone-badge-kind"
            data-kind={kind}
            checked={value.icon.includes(kind)}
            onCheckedChange={(on) => onChange({ ...value, icon: toggle(value.icon, kind, on) })}
          />
        </FormRow>
      ))}
      <FormRow
        label="Quiet hours"
        description={`No alerts in this window, in ${quiet?.timeZone ?? timeZone}. One comes when it ends if something still waits; the icon count still updates.`}
        htmlFor={`${idPrefix}-quiet`}
      >
        <Switch
          id={`${idPrefix}-quiet`}
          data-slot="phone-quiet-hours"
          checked={quiet !== undefined}
          onCheckedChange={(on) => {
            const { quiet: _off, ...rest } = value
            onChange(on ? { ...rest, quiet: { from: '22:00', to: '07:00', timeZone } } : rest)
          }}
        />
      </FormRow>
      {quiet ? (
        <div className="flex items-center gap-2 px-4 pb-3">
          <Input
            type="time"
            aria-label="Quiet from"
            className="w-32"
            value={quiet.from}
            onChange={(event) => event.target.value && onChange({ ...value, quiet: { ...quiet, from: event.target.value } })}
          />
          <span className="text-label text-muted-foreground">to</span>
          <Input
            type="time"
            aria-label="Quiet until"
            className="w-32"
            value={quiet.to}
            onChange={(event) => event.target.value && onChange({ ...value, quiet: { ...quiet, to: event.target.value } })}
          />
        </div>
      ) : null}
    </div>
  )
}

/** Saves on every change, keeps what the server answered, and falls back to it on a failed write. */
export function usePhoneNotificationsEditor(
  initial: PhonePushPrefs | undefined,
  save: (next: PhonePushPrefs) => Promise<PhonePushPrefs>,
  onSaved?: () => void,
) {
  const [value, setValue] = React.useState(initial)
  const [saved, flash] = useSavedFlash()
  React.useEffect(() => { if (initial) setValue((current) => current ?? initial) }, [initial])
  // Rapid toggles overlap their PUTs: only the newest answer may set the form, so an older one
  // landing last never shows a value the user already changed.
  const latest = React.useRef(0)
  const mutation = useMutation({
    mutationFn: ({ next }: { next: PhonePushPrefs; seq: number }) => save(next),
    onSuccess: (next, { seq }) => {
      if (seq !== latest.current) return
      setValue(next)
      flash()
      onSaved?.()
    },
    onError: (error: Error, { seq }) => {
      if (seq === latest.current) setValue(initial)
      toast(error.message, { tone: 'danger' })
    },
  })
  const change = (next: PhonePushPrefs) => {
    latest.current += 1
    setValue(next)
    mutation.mutate({ next, seq: latest.current })
  }
  return { value, change, saved }
}

/** Settings → Notifications inside the CezarBot app: this phone's own settings. */
export function ThisPhoneNotificationsCard() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: attentionKeys.phone, queryFn: ({ signal }) => getMyPushPrefs(signal), retry: false })
  // The page saves the settings; `understands` is what the app declared and passes through untouched.
  const editor = usePhoneNotificationsEditor(query.data, setMyPushPrefs, () => {
    void queryClient.invalidateQueries({ queryKey: attentionKeys.phone })
  })
  return (
    <SettingsCard
      id="this-phone"
      slot="this-phone-notifications"
      title="This phone"
      description="What this phone hears from this computer. Kept on the computer: the relay never learns what a push is about."
    >
      {editor.value ? (
        <PhoneNotificationsForm value={editor.value} onChange={editor.change} saved={editor.saved} idPrefix="this-phone" />
      ) : (
        <CardNote>{query.isError ? 'This computer runs an older cezar: update it to choose what this phone hears.' : 'Loading…'}</CardNote>
      )}
    </SettingsCard>
  )
}
