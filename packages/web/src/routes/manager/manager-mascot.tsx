import { mascotAsset } from './mascot-assets'
import { useEffect, useRef, useState } from 'react'
import type { ManagerMascot } from '@open-mercato/cezar-api-client'
import { cn } from '@/lib/utils'
import { blendPose, mascotPose, type MascotActivity } from './mascot-motion'
import { drawMascot, loadMascot, readMascotPalette } from './mascot-renderer'

export function ManagerMascot({ mascot, activity = 'idle', className, animated = true }: {
  mascot: ManagerMascot; activity?: MascotActivity; className?: string; animated?: boolean
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const requested = useRef(activity)
  requested.current = activity
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false); setFailed(false)
    const element = canvas.current
    if (!element) return
    const ctx = element.getContext('2d')
    if (!ctx) { setFailed(true); return }
    const palette = readMascotPalette(element)
    let disposed = false, frame = 0, visible = true, loaded = false
    let state = requested.current, started = performance.now(), previous = started
    let pose = mascotPose(state, 0), from = pose
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const scale = Math.min(devicePixelRatio || 1, 2)
    element.width = 400 * scale; element.height = 400 * scale; ctx.scale(scale, scale)
    let images: Awaited<ReturnType<typeof loadMascot>>
    const render = (now: number) => {
      frame = 0
      if (disposed || !loaded || !visible || document.hidden) return
      if (state !== requested.current) { from = pose; state = requested.current; started = now }
      if (now - previous > 200) started += now - previous
      previous = now
      const seconds = (now - started) / 1000
      const effective = (state === 'success' || state === 'alert') && seconds > 1.6 ? 'idle' : state
      const target = mascotPose(effective, motion.matches || !animated ? 0 : seconds)
      const amount = Math.min(1, (now - started) / 220)
      pose = motion.matches || !animated ? target : blendPose(from, target, amount * amount * (3 - 2 * amount))
      drawMascot(ctx, images, pose, mascot, palette)
      if (animated && !motion.matches) frame = requestAnimationFrame(render)
    }
    const wake = () => { if (!frame && loaded) { previous = performance.now(); frame = requestAnimationFrame(render) } }
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; if (visible) wake(); else cancelAnimationFrame(frame), frame = 0 })
    observer.observe(element)
    document.addEventListener('visibilitychange', wake)
    motion.addEventListener('change', wake)
    loadMascot(mascot).then((value) => { if (disposed) return; images = value; loaded = true; setReady(true); wake() }).catch(() => { if (!disposed) setFailed(true) })
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', wake); motion.removeEventListener('change', wake) }
  }, [mascot, animated])
  // A static pose must also reflect status changes when reduced motion is enabled.
  useEffect(() => {
    if (animated && !matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let disposed = false
    void loadMascot(mascot).then((images) => {
      const ctx = canvas.current?.getContext('2d')
      if (!disposed && ctx) drawMascot(ctx, images, mascotPose(activity, 0), mascot, readMascotPalette(canvas.current!))
    }).catch(() => {})
    return () => { disposed = true }
  }, [activity, animated, mascot])
  return (
    <span aria-hidden="true" data-slot="manager-mascot" data-mascot={mascot} data-activity={activity} className={cn('relative inline-block aspect-square shrink-0', className)}>
      {(!ready || failed) && <img src={mascotAsset(mascot, 'portrait')} alt="" className="absolute inset-0 size-full object-contain" />}
      <canvas ref={canvas} className={cn('size-full', (!ready || failed) && 'invisible')} />
    </span>
  )
}
