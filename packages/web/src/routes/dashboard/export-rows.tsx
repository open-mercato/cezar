import type { ExportRecord } from './export'
export function ExportRows({ rows }: { rows: ExportRecord[] }) {
  return <span hidden data-dashboard-export={JSON.stringify(rows)} />
}
