import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useGlobalSettings } from '@/components/global-settings'

/** Placeholder — replaced by the real sectioned dialog. */
export function GlobalSettingsDialog() {
  const { isOpen, close } = useGlobalSettings()
  return (
    <Dialog open={isOpen} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent>
        <DialogTitle>Global settings</DialogTitle>
        <DialogDescription>Loading…</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}
