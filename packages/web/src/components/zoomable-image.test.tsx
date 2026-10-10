import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ZoomableImage } from './zoomable-image'

afterEach(cleanup)

describe('ZoomableImage', () => {
  it('opens a lightbox on click and closes on backdrop click', () => {
    render(<ZoomableImage src="/api/v1/runs/r1/images/shot.png" alt="shot" data-slot="thread-image" />)
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
    render(<ZoomableImage src="/img.png" alt="pic" />)
    fireEvent.click(screen.getByRole('img'))
    expect(document.querySelector('[data-slot="image-lightbox"]')).not.toBeNull()
    // The lightbox is a Radix Dialog: Escape is heard on the document, from wherever focus is.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(document.querySelector('[data-slot="image-lightbox"]')).toBeNull()
  })
})
