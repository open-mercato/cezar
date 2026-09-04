import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { CezarClient, CezarProjectClient } from '@open-mercato/cezar-api-client'
import { CezarProvider } from '@open-mercato/cezar-react'

import { ZoomableImage } from './zoomable-image'

afterEach(cleanup)

function fakeCezarClient(): CezarClient {
  const project = (projectId: string | null): CezarProjectClient => ({
    projectId,
    runs: {} as CezarProjectClient['runs'],
    events: {} as CezarProjectClient['events'],
    resolveUrl: (url) => url,
  })
  return {
    identity: 'image-test',
    baseUrl: '',
    rpc: {} as CezarClient['rpc'],
    events: { forProject: (projectId = null) => project(projectId).events },
    forProject: (projectId = null) => project(projectId),
  } as CezarClient
}

function renderZoomableImage(
  props: React.ComponentProps<typeof ZoomableImage> & { 'data-slot'?: string },
) {
  return render(
    <CezarProvider client={fakeCezarClient()}>
      <ZoomableImage {...props} />
    </CezarProvider>,
  )
}

describe('ZoomableImage', () => {
  it('uses the render-time body fallback outside a Cezar provider', () => {
    render(<ZoomableImage src="/img.png" alt="standalone image" />)

    fireEvent.click(screen.getByRole('img', { name: 'standalone image' }))

    expect(document.body.querySelector(':scope > [data-slot="image-lightbox"]')).not.toBeNull()
  })

  it('opens a lightbox on click and closes on backdrop click', () => {
    renderZoomableImage({ src: '/api/v1/runs/r1/images/shot.png', alt: 'shot', 'data-slot': 'thread-image' })
    // The thumbnail forwards data-slot and is zoom-in cursored.
    const thumb = document.querySelector('[data-slot="thread-image"]') as HTMLImageElement
    expect(thumb).toBeTruthy()
    expect(document.querySelector('[data-slot="image-lightbox"]')).toBeNull()

    fireEvent.click(thumb)
    const lightbox = document.querySelector('[data-slot="image-lightbox"]')
    expect(lightbox).not.toBeNull()

    fireEvent.click(lightbox as HTMLElement)
    expect(document.querySelector('[data-slot="image-lightbox"]')).toBeNull()
  })

  it('closes on Escape', () => {
    renderZoomableImage({ src: '/img.png', alt: 'pic' })
    fireEvent.click(screen.getByRole('img'))
    expect(document.querySelector('[data-slot="image-lightbox"]')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('[data-slot="image-lightbox"]')).toBeNull()
  })

  it('contains the opened lightbox in the real provider portal', () => {
    renderZoomableImage({ src: '/img.png', alt: 'provider image' })

    fireEvent.click(screen.getByRole('img', { name: 'provider image' }))

    const portal = screen.getByTestId('cezar-portal')
    expect(within(portal).getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
  })
})
