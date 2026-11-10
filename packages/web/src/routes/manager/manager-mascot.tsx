import { useEffect, useRef, useState } from 'react'
import type { ManagerMascot } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'
import { blendPose, mascotFrameInterval, mascotPose, type MascotActivity } from './mascot-motion'
import { drawMascot, loadMascot, readMascotPalette } from './mascot-renderer'
import { MascotPortrait } from './mascot-portrait'

/** Rig space is 400 × 400; the backing store follows the CSS box (56 px at 2x draws 112, not 800).
 *  Capped at 3x, not 2x: a 2x store upscaled on a DPR 3 phone visibly blurs the artwork. */
export function mascotBackingSize(cssWidth: number, devicePixelRatio: number): number {
  return Math.max(1, Math.round(cssWidth * Math.min(devicePixelRatio || 1, 3)))
}

export function ManagerMascot({ mascot, activity = 'idle', className, animated = true }: {
  mascot: ManagerMascot; activity?: MascotActivity; className?: string; animated?: boolean
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const requested = useRef(activity)
  requested.current = activity
  const wakeRef = useRef<() => void>(undefined)
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false); setFailed(false)
    const element = canvas.current
    if (!element) return
    const ctx = element.getContext('2d')
    if (!ctx) { setFailed(true); return }
    const palette = readMascotPalette(element)
    let disposed = false, frame = 0, timer: ReturnType<typeof setTimeout> | undefined, visible = true, loaded = false
    let state = requested.current, started = performance.now(), previous = started
    let pose = mascotPose(state, 0), from = pose
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    let images: Awaited<ReturnType<typeof loadMascot>>
    const paint = () => { if (loaded) drawMascot(ctx, images, pose, mascot, palette) }
    const resize = () => {
      const size = mascotBackingSize(element.getBoundingClientRect().width, devicePixelRatio)
      if (element.width === size && element.height === size) return
      // Resizing clears the bitmap and the transform: repaint now, not on the next tick.
      element.width = size; element.height = size
      ctx.setTransform(size / 400, 0, 0, size / 400, 0, 0)
      ctx.imageSmoothingQuality = 'high'
      paint()
    }
    const stop = () => { cancelAnimationFrame(frame); frame = 0; clearTimeout(timer); timer = undefined }
    const render = (now: number) => {
      frame = 0
      if (disposed || !loaded || !visible || document.hidden) return
      if (state !== requested.current) { from = pose; state = requested.current; started = now }
      if (now - previous > 200) started += now - previous
      previous = now
      const still = motion.matches || !animated
      const seconds = (now - started) / 1000
      const effective = (state === 'success' || state === 'alert') && seconds > 1.6 ? 'idle' : state
      const target = mascotPose(effective, still ? 0 : seconds)
      const amount = Math.min(1, (now - started) / 220)
      pose = still ? target : blendPose(from, target, amount * amount * (3 - 2 * amount))
      paint()
      if (still) return
      // Slow states (idle breathing, waiting, error) redraw at ~15 fps; blends and busy states at 60.
      const interval = amount < 1 ? 0 : mascotFrameInterval(effective)
      if (interval) timer = setTimeout(() => { timer = undefined; if (!disposed) frame = requestAnimationFrame(render) }, interval)
      else frame = requestAnimationFrame(render)
    }
    const wake = () => {
      if (frame || timer || !loaded) return
      previous = performance.now(); frame = requestAnimationFrame(render)
    }
    wakeRef.current = () => { stop(); wake() }
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; if (visible) wake(); else stop() })
    observer.observe(element)
    const sizes = new ResizeObserver(resize)
    sizes.observe(element)
    resize()
    const onVisibility = () => { if (document.hidden) stop(); else wake() }
    document.addEventListener('visibilitychange', onVisibility)
    motion.addEventListener('change', wake)
    loadMascot(mascot).then((value) => { if (disposed) return; images = value; loaded = true; setReady(true); wake() }).catch(() => { if (!disposed) setFailed(true) })
    return () => {
      disposed = true; stop(); wakeRef.current = undefined
      observer.disconnect(); sizes.disconnect()
      document.removeEventListener('visibilitychange', onVisibility); motion.removeEventListener('change', wake)
    }
  }, [mascot, animated])
  // A sleeping loop (static, or between slow frames) picks a new activity up at once.
  useEffect(() => { wakeRef.current?.() }, [activity])
  return (
    <span aria-hidden="true" data-slot="manager-mascot" data-mascot={mascot} data-activity={activity} className={cn('relative inline-block aspect-square shrink-0', className)}>
      {(!ready || failed) && <MascotPortrait mascot={mascot} className="absolute inset-0 size-full object-contain" />}
      <canvas ref={canvas} className={cn('size-full', (!ready || failed) && 'invisible')} />
    </span>
  )
}
