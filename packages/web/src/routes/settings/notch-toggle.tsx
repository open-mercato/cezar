import * as React from 'react'

import { Switch } from '@/components/ui/switch'

type NotchShell = { notch?: boolean }
type Ipc = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }

function ipc(): Ipc | undefined {
  return (window as unknown as { __TAURI_INTERNALS__?: Ipc }).__TAURI_INTERNALS__
}

/** Only a macOS shell that has the notch says so: a browser, Windows, Linux and an older shell
 *  never show the row. */
export function shellHasNotch(): boolean {
  const shell = (window as { __CEZ_DESKTOP__?: NotchShell }).__CEZ_DESKTOP__
  return shell?.notch === true && ipc() !== undefined
}

/** The shell owns this answer (`~/.cezar/desktop-notch.json`): it decides before any cockpit is up
 *  and whichever cezar version is active (spec 2026-11-01-desktop-notch). */
export function NotchToggle() {
  const [enabled, setEnabled] = React.useState<boolean | null>(null)

  React.useEffect(() => {
    let live = true
    ipc()
      ?.invoke('notch_enabled')
      .then((answer) => {
        if (live) setEnabled(answer === true)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  if (enabled === null) return null

  return (
    <section data-slot="notch-setting" className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          <label htmlFor="notch-enabled">Manager notch</label>
        </h2>
        <p className="text-ui text-muted-foreground">
          Shows the managers that are working or need you around the camera at the top of the
          screen. It stays out of the way while none are. On by default.
        </p>
      </div>
      <Switch
        id="notch-enabled"
        data-slot="notch-toggle"
        checked={enabled}
        onCheckedChange={(next) => {
          setEnabled(next)
          void ipc()?.invoke('set_notch_enabled', { enabled: next })
        }}
      />
    </section>
  )
}
