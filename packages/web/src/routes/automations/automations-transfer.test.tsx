import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { setApiScope, type AutomationImportPreview, type AutomationImportRow, type AutomationsFile } from '@open-mercato/cezar-api-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, exportAutomations, importAutomations, previewAutomationImport } from '@/api/client'
import { ExportAutomationsButton, ImportAutomationsDialog, confirmLabel } from './automations-transfer'

vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(),
  exportAutomations: vi.fn(),
  previewAutomationImport: vi.fn(),
  importAutomations: vi.fn(),
}))

const FILE: AutomationsFile = {
  format: 'cezar-automations',
  version: 1,
  exportedAt: '2026-11-04T12:00:00.000Z',
  automations: [],
}

const row = (overrides: Partial<AutomationImportRow> & Pick<AutomationImportRow, 'index' | 'name'>): AutomationImportRow => ({
  kind: 'schedule',
  action: 'create',
  issues: [],
  warnings: [],
  runsCommands: false,
  ...overrides,
})

const ROWS: AutomationImportRow[] = [
  row({ index: 0, name: 'Nightly bump', warnings: ['the one-time schedule is in the past — it will not fire until rescheduled'] }),
  row({ index: 1, name: 'Triage', kind: 'github', action: 'skip', collision: { id: 'a2', name: 'Triage' } }),
  row({ index: 2, name: 'Lint check', runsCommands: true, issues: ['runs shell commands — acknowledge them to import this row'] }),
]

const preview = (rows = ROWS, planDigest = 'd1'): AutomationImportPreview => ({ rows, planDigest })

let invalidate: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setApiScope(null)
  vi.mocked(previewAutomationImport).mockReset().mockResolvedValue(preview())
  vi.mocked(importAutomations).mockReset().mockResolvedValue({ created: ['n1'], replaced: [], skipped: 1 })
  vi.mocked(exportAutomations).mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderDialog() {
  const onOpenChange = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <QueryClientProvider client={queryClient}>
      <ImportAutomationsDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

function pickFile(content: string, name = 'automations.json') {
  const input = screen.getByLabelText('Automations file')
  fireEvent.change(input, { target: { files: [new File([content], name, { type: 'application/json' })] } })
}

const table = () => screen.findByRole('table')
const confirm = () => screen.getByRole('button', { name: /^(Import|Replace) / })
const lastPreviewCall = () => vi.mocked(previewAutomationImport).mock.calls.at(-1)![0]

describe('ImportAutomationsDialog', () => {
  it('previews the picked file as a table with action chips, notes and the commands badge', async () => {
    renderDialog()
    pickFile(JSON.stringify(FILE))

    const preview = await table()
    expect(previewAutomationImport).toHaveBeenCalledWith({ file: FILE })
    const rows = within(preview).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByText('Nightly bump')).toBeTruthy()
    const chip = (r: HTMLElement) => r.querySelector('[data-action-chip]')?.textContent
    expect(chip(rows[0]!)).toBe('Create')
    expect(within(rows[0]!).getByText(/one-time schedule is in the past/)).toBeTruthy()
    expect(chip(rows[1]!)).toBe('Skip')
    expect(within(rows[1]!).getByText('An automation named "Triage" already exists.')).toBeTruthy()
    expect(within(rows[2]!).getByText('runs shell commands')).toBeTruthy()
    expect(within(rows[2]!).getByText(/acknowledge them to import this row/)).toBeTruthy()
    // Only the collision gets an action select.
    expect(within(rows[0]!).queryByRole('combobox')).toBeNull()
    expect(within(rows[1]!).getByRole('combobox', { name: 'Action for Triage' })).toBeTruthy()
    // A non-skip row with issues blocks the import.
    expect(confirm().textContent).toBe('Import 2 automations (paused)')
    expect((confirm() as HTMLButtonElement).disabled).toBe(true)
  })

  it('re-previews with the chosen collision resolution and names what Replace overwrites', async () => {
    renderDialog()
    pickFile(JSON.stringify(FILE))
    await table()

    const select = screen.getByRole('combobox', { name: 'Action for Triage' })
    expect(within(select).getByRole('option', { name: 'Rename to "Triage (imported)"' })).toBeTruthy()
    vi.mocked(previewAutomationImport).mockResolvedValueOnce(
      preview(ROWS.map((r) => (r.index === 1 ? { ...r, action: 'replace' as const, target: 'a2' } : r)), 'd2'),
    )
    fireEvent.change(select, { target: { value: 'replace' } })

    await waitFor(() => expect(lastPreviewCall()).toEqual({ file: FILE, resolutions: { 1: { action: 'replace' } } }))
    expect(await screen.findByText('Replaces and pauses "Triage".')).toBeTruthy()
    expect(confirm().textContent).toBe('Import 2 automations and replace 1 (paused)')
  })

  it('sends acceptCommands for an acknowledged row and imports with the last plan digest', async () => {
    const { onOpenChange } = renderDialog()
    pickFile(JSON.stringify(FILE))
    await table()

    const cleared = ROWS.map((r) => (r.index === 2 ? { ...r, action: 'rename' as const, newName: r.name, issues: [] } : r))
    vi.mocked(previewAutomationImport).mockResolvedValueOnce(preview(cleared, 'd3'))
    fireEvent.click(screen.getByRole('checkbox', { name: /allow them to run/ }))

    await waitFor(() => expect(lastPreviewCall()).toEqual({
      file: FILE,
      resolutions: { 2: { action: 'rename', newName: 'Lint check', acceptCommands: true } },
    }))
    // The own-name rename still reads as a create.
    await waitFor(() => expect((confirm() as HTMLButtonElement).disabled).toBe(false))
    expect(document.querySelector('[data-row="2"] [data-action-chip]')?.textContent).toBe('Create')
    fireEvent.click(confirm())

    await waitFor(() => expect(importAutomations).toHaveBeenCalledWith({
      file: FILE,
      resolutions: { 2: { action: 'rename', newName: 'Lint check', acceptCommands: true } },
      planDigest: 'd3',
    }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['default', 'automations'] })
  })

  it('reports an unparseable file inline without asking the server', async () => {
    renderDialog()
    pickFile('{ not json', 'broken.json')

    expect((await screen.findByRole('alert')).textContent).toContain('"broken.json" is not valid JSON')
    expect(previewAutomationImport).not.toHaveBeenCalled()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows the server 400 for a newer file inline, with no preview', async () => {
    vi.mocked(previewAutomationImport).mockRejectedValue(
      new ApiError(400, 'this file was written by a newer cezar (version 2); update cezar to import it'),
    )
    renderDialog()
    pickFile(JSON.stringify({ ...FILE, version: 2 }))

    expect((await screen.findByRole('alert')).textContent).toContain('written by a newer cezar (version 2)')
    expect(screen.queryByRole('table')).toBeNull()
    expect((confirm() as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers a fresh review when the plan went stale (409)', async () => {
    vi.mocked(previewAutomationImport).mockResolvedValue(preview(ROWS.slice(0, 2)))
    vi.mocked(importAutomations).mockRejectedValueOnce(new ApiError(409, 'the project changed since the preview — review again'))
    const { onOpenChange } = renderDialog()
    pickFile(JSON.stringify(FILE))
    await table()

    fireEvent.click(confirm())
    expect((await screen.findByRole('alert')).textContent).toContain('the project changed since the preview')
    expect((confirm() as HTMLButtonElement).disabled).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()

    const calls = vi.mocked(previewAutomationImport).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Review again' }))
    await waitFor(() => expect(vi.mocked(previewAutomationImport).mock.calls.length).toBe(calls + 1))
    await waitFor(() => expect((confirm() as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('confirmLabel', () => {
  it('counts creates and replacements separately', () => {
    expect(confirmLabel([row({ index: 0, name: 'a' })])).toBe('Import 1 automation (paused)')
    expect(confirmLabel([row({ index: 0, name: 'a', action: 'replace' })])).toBe('Replace 1 automation (paused)')
    expect(confirmLabel([])).toBe('Import 0 automations (paused)')
  })
})

describe('ExportAutomationsButton', () => {
  it('downloads the exported file', async () => {
    vi.mocked(exportAutomations).mockResolvedValue(FILE)
    const createObjectURL = vi.fn(() => 'blob:x')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<ExportAutomationsButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(exportAutomations).toHaveBeenCalledWith()
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('cezar-automations-2026-11-04.json')
    click.mockRestore()
  })
})
