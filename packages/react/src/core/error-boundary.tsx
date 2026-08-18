import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface CezarErrorFallbackProps {
  error: Error
  reset(): void
}

export interface CezarErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode | ((props: CezarErrorFallbackProps) => ReactNode)
  onError?: (error: Error, info: ErrorInfo) => void
}

interface CezarErrorBoundaryState {
  error: Error | null
}

/** Render-failure isolation for independently embedded feature boundaries. */
export class CezarErrorBoundary extends Component<
  CezarErrorBoundaryProps,
  CezarErrorBoundaryState
> {
  override state: CezarErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): CezarErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info)
  }

  private readonly reset = () => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    if (typeof this.props.fallback === 'function') {
      return this.props.fallback({ error, reset: this.reset })
    }
    return this.props.fallback ?? <p role="alert">This Cezar view could not be displayed.</p>
  }
}
