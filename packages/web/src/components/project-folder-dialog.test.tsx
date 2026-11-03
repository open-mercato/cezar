import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { ProjectFolderDialog } from './project-folder-dialog'

function project(over: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'cezar',
    name: 'cezar',
    root: '/home/me/Projects/cezar',
    addedAt: '2026-07-01T00:00:00.000Z',
    lastOpenedAt: '2026-07-20T12:00:00.000Z',
    source: 'local',
    status: 'ok',
    branch: 'main',
    forge: 'github',
    ...over,
  }
}

describe('ProjectFolderDialog', () => {
  const projects = [
    project({ id: 'p1', name: 'Project 1' }),
    project({ id: 'p2', name: 'Project 2' }),
  ]

  beforeEach(() => {
    cleanup()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders in create mode and allows saving with a name', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(
      <ProjectFolderDialog
        projects={projects}
        folder={null}
        onClose={onClose}
        onSave={onSave}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Create project folder' })).not.toBeNull()

    const nameInput = screen.getByPlaceholderText('Client name')
    const saveButton = screen.getByRole('button', { name: 'Save folder' })

    // Save disabled while name is empty
    expect(saveButton.hasAttribute('disabled')).toBe(true)

    fireEvent.change(nameInput, { target: { value: 'Client Work' } })
    expect(saveButton.hasAttribute('disabled')).toBe(false)

    // Select project 1
    const p1Checkbox = screen.getByRole('checkbox', { name: 'Project 1' })
    fireEvent.click(p1Checkbox)

    fireEvent.click(saveButton)
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Client Work',
        projectIds: ['p1'],
      }),
      undefined,
    )
  })

  it('renders with accessible grouping attributes on the project list', () => {
    render(
      <ProjectFolderDialog
        projects={projects}
        folder={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    const group = screen.getByRole('group', { name: 'Select projects' })
    expect(group).not.toBeNull()
  })

  it('requires confirmation before deleting an existing folder', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const existing = { id: 'f1', name: 'Existing Folder', projectIds: ['p1'] }

    render(
      <ProjectFolderDialog
        projects={projects}
        folder={existing}
        onClose={onClose}
        onSave={onSave}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Organise folder' })).not.toBeNull()

    const deleteBtn = screen.getByRole('button', { name: 'Delete folder' })
    fireEvent.click(deleteBtn)

    // onSave has NOT been called yet
    expect(onSave).not.toHaveBeenCalled()

    // Confirmation buttons now visible
    const confirmBtn = screen.getByRole('button', { name: 'Confirm delete' })
    const keepFolderBtn = screen.getByRole('button', { name: 'Keep folder' })

    // Clicking keep folder keeps folder and resets delete state
    fireEvent.click(keepFolderBtn)
    expect(screen.getByRole('button', { name: 'Delete folder' })).not.toBeNull()
    expect(onSave).not.toHaveBeenCalled()

    // Click delete then confirm
    fireEvent.click(screen.getByRole('button', { name: 'Delete folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))

    expect(onSave).toHaveBeenCalledWith(null, 'f1')
  })

  it('renders in edit mode and allows updating name and projects', () => {
    const onSave = vi.fn()
    const onClose = vi.fn()
    const existing = { id: 'f1', name: 'Existing Folder', projectIds: ['p1'] }

    render(
      <ProjectFolderDialog
        projects={projects}
        folder={existing}
        onClose={onClose}
        onSave={onSave}
      />,
    )

    const nameInput = screen.getByPlaceholderText('Client name') as HTMLInputElement
    expect(nameInput.value).toBe('Existing Folder')

    const p1Checkbox = screen.getByRole('checkbox', { name: 'Project 1' }) as HTMLInputElement
    const p2Checkbox = screen.getByRole('checkbox', { name: 'Project 2' }) as HTMLInputElement
    expect(p1Checkbox.checked).toBe(true)
    expect(p2Checkbox.checked).toBe(false)

    // Deselect p1, select p2, change name
    fireEvent.click(p1Checkbox)
    fireEvent.click(p2Checkbox)
    fireEvent.change(nameInput, { target: { value: 'Renamed Folder' } })

    const saveBtn = screen.getByRole('button', { name: 'Save folder' })
    fireEvent.click(saveBtn)

    expect(onSave).toHaveBeenCalledWith(
      {
        id: 'f1',
        name: 'Renamed Folder',
        projectIds: ['p2'],
      },
      'f1',
    )
  })

  it('disables save button when folder name is whitespace only', () => {
    render(
      <ProjectFolderDialog
        projects={projects}
        folder={null}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    const nameInput = screen.getByPlaceholderText('Client name')
    const saveBtn = screen.getByRole('button', { name: 'Save folder' })

    fireEvent.change(nameInput, { target: { value: '    ' } })
    expect(saveBtn.hasAttribute('disabled')).toBe(true)
  })
})
