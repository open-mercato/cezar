import { Component, type ReactNode } from 'react'

import { toast } from '@/components/ui/toaster'

/**
 * Contains a render error inside one dialog. React unmounts the WHOLE root on an uncaught render
 * error, so without this a bug in an optional dialog — or a server of another version answering
 * a shape the dialog did not expect — blanks the entire cockpit. With it, the dialog closes and a
 * toast says what failed; everything behind it keeps working.
 */
export class DialogErrorBoundary extends Component<
  { children: ReactNode; label: string; onError: () => void },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[cezar] ${this.props.label} failed to render`, error)
    toast(`${this.props.label} failed to open: ${error instanceof Error ? error.message : String(error)}`, {
      tone: 'danger',
    })
    this.props.onError()
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
