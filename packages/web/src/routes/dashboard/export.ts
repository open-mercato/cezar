import { formatAmount } from './format'
export type ExportRecord = {
  section: string
  entity?: string
  metric: string
  value: number | string | null
  unit?: string
  reportedTasks?: number
  totalTasks?: number
  asOf?: string
  note?: string
}
export type DashboardExport = {
  generatedAt: string
  source: string
  title?: string
  notices: string[]
  modules: {
    id: string
    title: string
    filters: string
    notes: string
    html: string
    rows: ExportRecord[]
  }[]
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
const scope =
  'Visible modules and loaded rows only. Filters and report availability apply. Retained task usage is not an invoice or a complete history.'
const confidential = 'Confidential — internal distribution only'
const summaryLabels: Record<string, { label: string; usd?: boolean }> = {
  costUsd: { label: 'Reported cost', usd: true },
  inputTokens: { label: 'Input tokens' },
  outputTokens: { label: 'Output tokens' },
  needsYou: { label: 'Needs you' },
  running: { label: 'Running now' },
  completed: { label: 'Completed in period' },
  failed: { label: 'Failed outcomes in period' },
  medianCycleHours: { label: 'Median cycle (hours)' },
}
function formatSummaryValue(value: number | string | null, usd?: boolean) {
  if (value == null) return 'Unavailable'
  if (typeof value === 'string') return value
  return formatAmount(value, usd)
}
function summaryTiles(report: DashboardExport) {
  const seen = new Set<string>()
  const tiles: { label: string; value: string; note?: string }[] = []
  for (const module of report.modules) {
    for (const row of module.rows) {
      if (row.section !== 'totals' && row.section !== 'fleet' && row.section !== 'overview')
        continue
      const spec = summaryLabels[row.metric]
      if (!spec || seen.has(row.metric)) continue
      seen.add(row.metric)
      tiles.push({
        label: spec.label,
        value: formatSummaryValue(row.value, spec.usd),
        note: [
          row.metric === 'needsYou' || row.metric === 'running'
            ? row.note || 'Current non-archived state'
            : module.filters,
          row.asOf ? `Data as of ${row.asOf}` : '',
          row.reportedTasks != null
            ? `${row.reportedTasks} of ${row.totalTasks} tasks reported`
            : '',
        ]
          .filter(Boolean)
          .join(' · '),
      })
    }
  }
  return tiles
}

function sanitizeModule(source: HTMLElement) {
  const node = source.cloneNode(true) as HTMLElement
  node
    .querySelectorAll(
      'script,style,link,img,iframe,object,embed,input,[hidden],[data-dashboard-export],[data-export-exclude]',
    )
    .forEach((el) => el.remove())
  node.querySelectorAll('select').forEach((el, i) => {
    const selected = source.querySelectorAll('select')[i]
    el.replaceWith(
      document.createTextNode(': ' + (selected?.selectedOptions[0]?.textContent ?? '')),
    )
  })
  node
    .querySelectorAll('[data-export-row],[data-dashboard-row]')
    .forEach((el) => el.classList.add('report-row'))
  node.querySelectorAll('summary').forEach((el) => {
    const heading = document.createElement('h3')
    heading.textContent = el.getAttribute('data-export-heading') || el.textContent
    el.replaceWith(heading)
  })
  node.querySelectorAll('button').forEach((button) => {
    if (button.hasAttribute('data-export-keep')) {
      const replacement = document.createElement('div')
      for (const attr of [...button.attributes])
        if (['class', 'style', 'title'].includes(attr.name))
          replacement.setAttribute(attr.name, attr.value)
      replacement.append(...button.childNodes)
      button.replaceWith(replacement)
    } else button.remove()
  })
  node.querySelectorAll('details').forEach((el) => {
    const replacement = document.createElement('div')
    replacement.className = el.className
    replacement.append(...el.childNodes)
    el.replaceWith(replacement)
  })
  for (const el of [node, ...node.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (
        attr.name.startsWith('on') ||
        ['href', 'src', 'srcset', 'action', 'formaction', 'tabindex'].includes(attr.name) ||
        attr.name.startsWith('data-')
      )
        el.removeAttribute(attr.name)
    }
  }
  node.removeAttribute('style') // a drag in progress must not displace the report
  return node.innerHTML
}
export function collectDashboardExport(
  root: HTMLElement,
  generatedAt: string,
  source: string,
  title?: string,
): DashboardExport {
  return {
    generatedAt,
    source,
    title: title || undefined,
    notices: [...root.querySelectorAll('[role=alert],[role=status]')]
      .filter((el) => !el.closest('[data-dashboard-module]'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean),
    modules: [...root.querySelectorAll<HTMLElement>('[data-dashboard-module]')].map(
      (module) => {
        const filters = [...module.querySelectorAll('select')]
          .map(
            (select) =>
              `${select.closest('label')?.childNodes[0]?.textContent?.trim() ?? 'Filter'}: ${select.selectedOptions[0]?.textContent}`,
          )
          .concat(
            [...module.querySelectorAll<HTMLElement>('[data-export-context]')].map(
              (el) => el.dataset.exportContext!,
            ),
          )
          .join('; ')
        const notes = [
          ...new Set(
            [...module.querySelectorAll('p,[role="alert"],[role="status"]')]
              .filter(
                (el) =>
                  !el.closest('table,[data-export-exclude]') &&
                  !el.querySelector('p,[role="alert"],[role="status"]'),
              )
              .map((el) => {
                const copy = el.cloneNode(true) as HTMLElement
                copy
                  .querySelectorAll('table,button,select,summary,[data-export-exclude]')
                  .forEach((child) => child.remove())
                return copy.textContent?.trim()
              })
              .filter(Boolean),
          ),
        ].join(' | ')
        return {
          id: module.dataset.dashboardModule!,
          title: module.querySelector('h2')?.textContent ?? module.dataset.dashboardModule!,
          filters,
          notes,
          html: sanitizeModule(module),
          rows: [...module.querySelectorAll<HTMLElement>('[data-dashboard-export]')].flatMap(
            (el) => JSON.parse(el.dataset.dashboardExport!) as ExportRecord[],
          ),
        }
      },
    ),
  }
}
function csvCell(value: string | number | null | undefined) {
  let text = value == null ? '' : String(value)
  // Spreadsheet formula injection applies to text, never to trusted numeric values.
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+@\-]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
export function dashboardCsv(report: DashboardExport) {
  const rows: (string | number | null | undefined)[][] = [
    [
      'generated_at',
      'source',
      'module',
      'filters',
      'section',
      'entity',
      'metric',
      'value',
      'unit',
      'availability',
      'reported_tasks',
      'total_tasks',
      'as_of',
      'notes',
    ],
  ]
  for (const module of report.modules) {
    rows.push([
      report.generatedAt,
      report.source,
      module.title,
      module.filters,
      'context',
      '',
      'scope',
      scope,
      '',
      '',
      '',
      '',
      '',
      [
        ...(report.title ? [`Report title: ${report.title}`] : []),
        ...report.notices,
        module.notes,
      ].join(' | '),
    ])
    for (const row of module.rows)
      rows.push([
        report.generatedAt,
        report.source,
        module.title,
        module.filters,
        row.section,
        row.entity,
        row.metric,
        row.value,
        row.unit,
        row.value === null
          ? 'unavailable'
          : typeof row.value === 'number'
            ? 'measured'
            : 'reported',
        row.reportedTasks,
        row.totalTasks,
        row.asOf,
        row.note,
      ])
  }
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
export function printableDashboard(report: DashboardExport, styles: string[]) {
  const tiles = summaryTiles(report)
  return `<!doctype html><html class="light"><head><meta charset="utf-8"><title>${escape(report.title || 'Dashboard')} ${escape(report.generatedAt.slice(0, 10))}</title>${styles.join('')}<style>
@page {
  size:A4; margin:14mm 14mm 18mm;
  @bottom-left { content:"${confidential}"; font-family:system-ui,sans-serif; font-size:9px; color:var(--muted-foreground); }
  @bottom-right { content:"Page " counter(page) " of " counter(pages); font-family:system-ui,sans-serif; font-size:9px; color:var(--muted-foreground); }
}
html,body { height:auto!important; overflow:visible!important; background:var(--background)!important; color:var(--foreground)!important; }
* { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
body { margin:0; font:12px/1.5 system-ui,sans-serif; }
.report-heading { border-bottom:2px solid var(--violet); padding-bottom:16px; margin-bottom:20px; }
.report-heading h1 { font-size:26px; margin:0 0 8px; }
.report-heading p { margin:4px 0; color:var(--muted-foreground); }
.report-confidential { display:inline-block; margin:6px 0; padding:2px 8px; border:1px solid var(--destructive); border-radius:4px; color:var(--destructive); font-size:11px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; }
.report-summary { margin:0 0 24px; }
.report-summary h2 { font-size:12px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted-foreground); }
.summary-grid { display:flex; flex-wrap:wrap; gap:12px; }
.summary-tile { flex:1 1 140px; border:1px solid var(--border); border-radius:8px; padding:12px 14px; break-inside:avoid; }
.summary-value { display:block; font-size:22px; font-weight:600; }
.summary-label { display:block; font-size:11px; color:var(--muted-foreground); margin-top:2px; }
.summary-note { display:block; font-size:10px; color:var(--soft-foreground); margin-top:4px; }
.report-module { margin:0 0 20px; break-before:auto; }
.report-module h2,.report-module h3 { break-after:avoid; }
.report-module-usage, .report-module-fleet { break-inside:avoid; }
.report-module-usage label { min-height:0!important; }
.report-module-usage .space-y-4 > :not(:last-child) { margin-block-end:8px!important; }
.report-module-usage .report-row { padding-top:5px!important; padding-bottom:5px!important; }
.report-cost-metrics { grid-template-columns:repeat(3,minmax(0,1fr))!important; }
.report-cost-metrics > div { padding:12px!important; break-inside:avoid; }
.report-cost-metrics .text-3xl { font-size:22px!important; }
.report-module > :first-child, .report-module header, .report-context { break-after:avoid; }
.report-module .report-row, .report-module tr { break-inside:avoid; }
.report-module thead { display:table-header-group; }
.report-module .report-row { padding-top:8px!important; padding-bottom:8px!important; }
.report-module a { min-height:0!important; }
.report-module > div { padding-top:12px!important; padding-bottom:12px!important; }
.report-module * { overflow:visible !important; max-height: none !important; animation:none!important; transition:none!important; box-shadow:none!important; }
.report-module a { color:inherit; text-decoration:none; }
.report-module svg { max-width:24px; }
.report-module [role=region] > div, .report-module [role=region] > p { break-inside:avoid; }
.report-module .sr-only { display:none!important; }
.report-context { font-size:11px; color:var(--muted-foreground); margin:0 0 8px; }
</style></head><body><header class="report-heading"><h1>${escape(report.title || 'Dashboard report')}</h1><p>${escape(report.generatedAt)} · ${escape(report.source)}</p><span class="report-confidential">${confidential}</span><p>${escape(scope)}</p>${report.notices.map((note) => `<p>${escape(note)}</p>`).join('')}</header>${
    tiles.length
      ? `<section class="report-summary"><h2>Executive summary</h2><div class="summary-grid">${tiles
          .map(
            (tile) =>
              `<div class="summary-tile"><span class="summary-value">${escape(tile.value)}</span><span class="summary-label">${escape(tile.label)}</span>${tile.note ? `<span class="summary-note">${escape(tile.note)}</span>` : ''}</div>`,
          )
          .join('')}</div></section>`
      : ''
  }${report.modules.map((module) => `<section class="report-module${module.id === 'usage' ? ' report-module-usage' : module.id === 'fleet' ? ' report-module-fleet' : ''}"><p class="report-context">${escape(module.filters)}</p>${module.html}</section>`).join('')}</body></html>`
}
