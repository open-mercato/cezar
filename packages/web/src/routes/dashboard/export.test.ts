import { expect, it } from 'vitest'
import { collectDashboardExport, dashboardCsv, printableDashboard } from './export'

it('exports displayed modules in order with exact numbers, unavailable vs zero and safe spreadsheet cells', () => {
  const root = document.createElement('div')
  root.innerHTML =
    '<section data-dashboard-module="usage"><h2>Usage</h2></section><section data-dashboard-module="fleet"><h2>Fleet</h2></section>'
  const rows = document.createElement('div')
  rows.dataset.dashboardExport = JSON.stringify([
    { section: 'totals', metric: 'costUsd', value: 0, unit: 'USD' },
    { section: 'totals', metric: 'outputTokens', value: null },
    { section: 'project', entity: '=WEBSERVICE("bad")', metric: 'costUsd', value: 0.000012 },
  ])
  root.firstElementChild!.append(rows)
  const report = collectDashboardExport(
    root,
    '2026-09-19T00:00:00.000Z',
    'http://localhost:41226',
  )
  const csv = dashboardCsv(report)
  expect(csv).toContain('0.000012')
  expect(csv).toContain('unavailable')
  expect(csv).toContain("'=WEBSERVICE")
  expect(csv).toContain('measured')
  expect(report.modules.map((m) => m.id)).toEqual(['usage', 'fleet'])
})

it('freezes a printable report without actions, scripts or clipped lists; preserves bars and filters', () => {
  const root = document.createElement('div')
  root.innerHTML =
    '<section data-dashboard-module="usage"><h2>&lt;unsafe&gt;</h2><label>Period<select><option>All</option><option selected>7 days</option></select></label><div style="max-height: 320px; overflow: auto"><p>Retained row</p><button>Retry</button><button data-export-keep style="height:45%">Bar</button></div><script>bad()</script><img src="https://bad.test/x" onerror="bad()"></section>'
  const html = printableDashboard(
    collectDashboardExport(root, '2026-09-19T00:00:00.000Z', 'localhost'),
    [],
  )
  expect(html).toContain('&lt;unsafe&gt;')
  expect(html).toContain('7 days')
  expect(html).toContain('Retained row')
  expect(html).toContain('height:45%')
  expect(html).not.toContain('<script')
  expect(html).not.toContain('https://bad.test')
  expect(html).not.toContain('Retry')
  expect(html).not.toContain('<select')
  expect(html).toContain('max-height: none !important')
})

it('gives the printable report a cover title, confidentiality mark and page numbers for formal distribution', () => {
  const root = document.createElement('div')
  root.innerHTML = '<section data-dashboard-module="usage"><h2>Usage</h2></section>'
  const html = printableDashboard(
    collectDashboardExport(
      root,
      '2026-09-19T00:00:00.000Z',
      'localhost',
      'Fleet review for leadership',
    ),
    [],
  )
  expect(html).toContain('<h1>Fleet review for leadership</h1>')
  expect(html).toContain('Confidential — internal distribution only')
  expect(html).toContain('counter(page)')
  expect(html).toContain('counter(pages)')
})

it('falls back to a generic report title when none is given', () => {
  const root = document.createElement('div')
  root.innerHTML = '<section data-dashboard-module="usage"><h2>Usage</h2></section>'
  const html = printableDashboard(
    collectDashboardExport(root, '2026-09-19T00:00:00.000Z', 'localhost'),
    [],
  )
  expect(html).toContain('<h1>Dashboard report</h1>')
})

it('highlights key totals and fleet counts in an executive summary before module detail', () => {
  const root = document.createElement('div')
  root.innerHTML =
    '<section data-dashboard-module="usage"><h2>Usage</h2></section><section data-dashboard-module="fleet"><h2>Fleet</h2></section>'
  const usageRows = document.createElement('div')
  usageRows.dataset.dashboardExport = JSON.stringify([
    {
      section: 'totals',
      metric: 'costUsd',
      value: 1234.5,
      unit: 'USD',
      reportedTasks: 8,
      totalTasks: 10,
    },
  ])
  root.children[0]!.append(usageRows)
  const fleetRows = document.createElement('div')
  fleetRows.dataset.dashboardExport = JSON.stringify([
    { section: 'fleet', metric: 'needsYou', value: 3, unit: 'tasks' },
  ])
  root.children[1]!.append(fleetRows)
  const html = printableDashboard(
    collectDashboardExport(root, '2026-09-19T00:00:00.000Z', 'localhost'),
    [],
  )
  const summaryIndex = html.indexOf('Executive summary')
  const usageModuleIndex = html.indexOf('<section class="report-module')
  expect(summaryIndex).toBeGreaterThan(-1)
  expect(summaryIndex).toBeLessThan(usageModuleIndex)
  expect(html).toContain('$1234.50')
  expect(html).toContain('8 of 10 tasks reported')
  expect(html).toContain('Needs you')
  expect(html).toContain('>3<')
})

it('includes the report title in the CSV context row when set', () => {
  const root = document.createElement('div')
  root.innerHTML = '<section data-dashboard-module="usage"><h2>Usage</h2></section>'
  const csv = dashboardCsv(
    collectDashboardExport(
      root,
      '2026-09-19T00:00:00.000Z',
      'localhost',
      'Fleet review for leadership',
    ),
  )
  expect(csv).toContain('Report title: Fleet review for leadership')
})

it('preserves tiny amounts, period and snapshot time in the summary', () => {
  const root = document.createElement('div')
  root.innerHTML =
    '<section data-dashboard-module="usage"><h2>Usage</h2><div data-export-context="Last 7 days"></div></section>'
  const row = document.createElement('span')
  row.dataset.dashboardExport = JSON.stringify([
    { section: 'totals', metric: 'costUsd', value: 0.000012, asOf: '2026-09-18T10:00:00Z' },
  ])
  root.firstElementChild!.append(row)
  const html = printableDashboard(
    collectDashboardExport(root, '2026-09-19T00:00:00Z', 'localhost'),
    [],
  )
  expect(html).toContain('$0.000012')
  expect(html).toContain('Last 7 days')
  expect(html).toContain('Data as of 2026-09-18T10:00:00Z')
})

it('keeps current summary scope separate from outcomes and cleans report-only content', () => {
  const root = document.createElement('div')
  root.innerHTML =
    '<section data-dashboard-module="overview"><h2>Overview</h2><label>Outcomes period<select><option>Last 30 days</option></select></label><div role="status"><p>Partial coverage</p></div><details><summary data-export-heading="Daily data">View data table</summary><p>Explanation</p><table><tbody><tr><td>TABLE_DATA</td></tr></tbody></table></details><button data-export-keep data-export-row>2<span data-export-exclude>View tasks</span></button></section>'
  const rows = document.createElement('span')
  rows.dataset.dashboardExport = JSON.stringify([
    {
      section: 'overview',
      metric: 'needsYou',
      value: 2,
      asOf: '2026-09-19',
      note: 'Current non-archived state',
    },
  ])
  root.firstElementChild!.append(rows)
  const report = collectDashboardExport(root, '2026-09-19', 'localhost')
  expect(report.modules[0]!.notes).toBe('Partial coverage | Explanation')
  expect(report.modules[0]!.html).toContain('Outcomes period: Last 30 days')
  expect(report.modules[0]!.html).toContain('Daily data')
  expect(report.modules[0]!.html).not.toContain('View tasks')
  expect(report.modules[0]!.html).toContain('report-row')
  const html = printableDashboard(report, [])
  const summary = html.slice(
    html.indexOf('<section class="report-summary">'),
    html.indexOf('<section class="report-module'),
  )
  expect(summary).toContain('Current non-archived state')
  expect(summary).not.toContain('Last 30 days')
})
