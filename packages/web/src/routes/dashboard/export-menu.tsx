import { useState, type RefObject } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { collectDashboardExport, dashboardCsv, printableDashboard } from './export'

export function DashboardExportMenu({
  dashboard,
}: {
  dashboard: RefObject<HTMLDivElement | null>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const exportView = (format: 'csv' | 'pdf') => {
    setError('')
    try {
      if (!dashboard.current) return
      const report = collectDashboardExport(
        dashboard.current,
        new Date().toISOString(),
        location.origin,
        title.trim(),
      )
      if (!report.modules.length) {
        setError('Show at least one dashboard module before exporting.')
        return
      }
      if (format === 'csv') {
        const url = URL.createObjectURL(
          new Blob([dashboardCsv(report)], { type: 'text/csv;charset=utf-8' }),
        )
        const link = document.createElement('a')
        link.href = url
        link.download = `dashboard-${report.generatedAt.replaceAll(':', '-')}.csv`
        document.body.append(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setOpen(false)
      } else {
        setBusy(true)
        const styles = [...document.querySelectorAll('link[rel="stylesheet"],style')].flatMap(
          (el) => {
            if (el.tagName === 'STYLE') return [el.outerHTML]
            const href = (el as HTMLLinkElement).href
            if (new URL(href).origin !== location.origin) return []
            const link = document.createElement('link')
            link.rel = 'stylesheet'
            link.href = href
            return [link.outerHTML]
          },
        )
        const frame = document.createElement('iframe')
        frame.title = 'Dashboard PDF report'
        frame.style.cssText =
          'position:fixed;width:1000px;height:1px;bottom:0;left:0;border:0;opacity:0;pointer-events:none'
        let timer: ReturnType<typeof setTimeout>
        const dispose = () => {
          clearTimeout(timer)
          frame.remove()
          setBusy(false)
        }
        frame.onload = async () => {
          try {
            const win = frame.contentWindow!
            await win.document.fonts.ready
            win.addEventListener('afterprint', dispose, { once: true })
            win.focus()
            win.print()
            setOpen(false)
            setBusy(false)
          } catch {
            dispose()
            setError('Could not open the print dialog. Please try again.')
          }
        }
        timer = setTimeout(dispose, 120_000)
        frame.srcdoc = printableDashboard(report, styles)
        document.body.append(frame)
      }
    } catch {
      setBusy(false)
      setError('Could not prepare the export. Please try again.')
    }
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="min-h-11" disabled={busy}>
          <Download className="size-4" />
          {busy ? 'Preparing report…' : 'Export'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-w-[calc(100vw-2rem)] space-y-3">
        <p className="text-sm font-medium">Export current dashboard</p>
        <p className="text-xs text-muted-foreground">
          Visible modules, current filters and loaded rows. Hidden metrics are excluded.
        </p>
        <label className="block space-y-1 text-xs text-muted-foreground">
          Report title (optional)
          <input
            className="min-h-11 w-full rounded-md border bg-background px-3 text-sm text-foreground"
            placeholder="e.g. Fleet review for leadership"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <Button className="min-h-11 w-full" onClick={() => exportView('pdf')}>
          PDF report…
        </Button>
        <p className="text-xs text-muted-foreground">Choose Save as PDF in the print dialog.</p>
        <Button variant="outline" className="min-h-11 w-full" onClick={() => exportView('csv')}>
          Download CSV
        </Button>
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
