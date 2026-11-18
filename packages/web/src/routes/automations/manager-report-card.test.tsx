import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ManagerReportCard } from './manager-report-card'

afterEach(cleanup)

const managers = [{ id: 'm1', name: 'Notes Manager' }, { id: 'm2', name: 'Coding Manager' }]

describe('ManagerReportCard', () => {
  it('renders nothing when it reports nowhere and no manager exists', () => {
    const { container } = render(<ManagerReportCard managers={[]} onChange={() => undefined} />)
    expect(container.querySelector('[data-slot="manager-report-card"]')).toBeNull()
  })

  it('names the manager it reports to and unlinks it', () => {
    const onChange = vi.fn()
    render(<ManagerReportCard report={{ managerId: 'm1', mode: 'post-result' }} managers={managers} onChange={onChange} />)
    expect(screen.getByText('Notes Manager')).not.toBeNull()
    expect(screen.getByRole('combobox', { name: 'What to post' }).textContent).toContain('Every result')
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('says so when the linked manager is not listed', () => {
    render(<ManagerReportCard report={{ managerId: 'gone', mode: 'notify-on-failure' }} managers={managers} onChange={() => undefined} />)
    expect(screen.getByText('A manager no longer listed')).not.toBeNull()
    expect(screen.getByText('Only a failed run is posted, marked important.')).not.toBeNull()
  })

  it('offers the managers to link an unlinked automation to', () => {
    render(<ManagerReportCard managers={managers} onChange={() => undefined} />)
    expect(screen.getByRole('combobox', { name: 'Report to a manager' }).textContent).toContain('Post results to a manager…')
  })
})
