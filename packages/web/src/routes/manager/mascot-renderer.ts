import { mascotAsset } from './mascot-assets'
import type { MascotPose } from './mascot-motion'
export const MASCOT_PARTS = ['body', 'left', 'right', 'leg-left', 'leg-right', 'happy', 'blink', 'concerned', 'excited', 'laptop', 'typing-left', 'typing-right', 'focused'] as const
export type MascotImages = Record<typeof MASCOT_PARTS[number], HTMLImageElement>
export function readMascotPalette(element: Element) {
  const style = getComputedStyle(element)
  const token = (name: string) => style.getPropertyValue('--mascot-' + name).trim()
  return { paper: token('paper'), outline: token('outline'), ink: token('ink'), gold: token('gold'), edge: token('edge'), symbol: token('symbol'), spark: token('spark'), shadow: token('shadow') }
}
const cache = new Map<string, Promise<MascotImages>>()

export function loadMascot(id: string): Promise<MascotImages> {
  let pending = cache.get(id)
  if (!pending) {
    pending = Promise.all(MASCOT_PARTS.map((part) => new Promise<[typeof part, HTMLImageElement]>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve([part, image])
      image.onerror = () => reject(new Error(`Unable to load mascot ${id}/${part}`))
      image.src = mascotAsset(['laptop', 'typing-left', 'typing-right', 'focused'].includes(part) ? 'shared' : id, part)
    }))).then((entries) => Object.fromEntries(entries) as MascotImages)
    cache.set(id, pending)
    void pending.catch(() => cache.delete(id))
  }
  return pending
}

/** Raster parts retain the artwork's shading; only their rig transforms are animated. */
export function drawMascot(ctx: CanvasRenderingContext2D, images: MascotImages, p: MascotPose, mascot: string, colors: ReturnType<typeof readMascotPalette>) {
  ctx.clearRect(0, 0, 400, 400)
  ctx.save()
  ctx.fillStyle = colors.shadow
  ctx.beginPath(); ctx.ellipse(200, 383, 112 + p.bob, 9, 0, 0, Math.PI * 2); ctx.fill()
  ctx.translate(200, 300 + p.bob); ctx.rotate(p.lean); ctx.translate(-200, -300)
  const draw = (name: keyof MascotImages, x: number, y: number, size: number, alpha = 1) => {
    if (alpha <= 0) return
    ctx.globalAlpha = alpha; ctx.drawImage(images[name], x, y, size, size); ctx.globalAlpha = 1
  }
  draw('leg-left', 105, 290 + p.leftFoot, 120)
  draw('leg-right', 185, 290 + p.rightFoot, 120)
  draw('body', 40, 20, 320)
  ctx.save(); ctx.translate(100, 215); ctx.rotate(p.left); draw('left', mascot === 'scout' ? -50 : -100, mascot === 'scout' ? -25 : -60, mascot === 'scout' ? 120 : 200, 1 - p.laptop); ctx.restore()
  ctx.save(); ctx.translate(310, 200); ctx.rotate(p.right); draw('right', -40, -25, 120, 1 - p.laptop); ctx.restore()
  draw('happy', 120, 65, 160, p.happy)
  draw('blink', 120, 65, 160, p.blink)
  draw('concerned', 120, 65, 160, p.concerned)
  draw('excited', 120, 65, 160, p.excited)
  if (p.focused > 0) {
    if (mascot === 'analyst') draw('happy', 120, 65, 160, p.focused)
    else { ctx.globalAlpha = p.focused; ctx.drawImage(images.focused, 140, 96, 120, 103); ctx.globalAlpha = 1 }
  }
  if (p.laptop > 0) {
    ctx.globalAlpha = p.laptop
    ctx.drawImage(images['typing-left'], 85, 244 + p.typing, 120, 60)
    ctx.drawImage(images['typing-right'], 220, 244 - p.typing, 120, 60)
    ctx.globalAlpha = 1
  }
  draw('laptop', 55, 160, 300, p.laptop)
  ctx.restore()
  if (p.question > 0 || p.hourglass > 0) {
    ctx.globalAlpha = Math.max(p.question, p.hourglass)
    ctx.fillStyle = colors.paper; ctx.strokeStyle = colors.outline; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.roundRect(312, 68, 45, 46, 14); ctx.fill(); ctx.stroke()
    ctx.fillStyle = colors.ink; ctx.font = 'bold 30px Georgia'; ctx.textAlign = 'center'
    if (p.question > 0.5) ctx.fillText('?', 334, 101)
    else {
      ctx.strokeStyle = colors.gold; ctx.lineWidth = 3; ctx.beginPath()
      ctx.moveTo(325,80); ctx.lineTo(344,80); ctx.lineTo(344,83); ctx.lineTo(327,101); ctx.lineTo(344,101)
      ctx.moveTo(325,80); ctx.lineTo(325,83); ctx.lineTo(342,101); ctx.stroke()
    }
    ctx.globalAlpha = 1
  }
  if (p.orbit > 0) {
    ctx.globalAlpha = p.orbit
    for (const [x,y,label] of [[42,80,'⑂'],[200,22,'</>'],[355,90,'⑂']] as const) {
      ctx.fillStyle=colors.paper; ctx.strokeStyle=colors.edge; ctx.lineWidth=1.5
      ctx.beginPath(); ctx.roundRect(x-19,y-18,38,36,8); ctx.fill(); ctx.stroke()
      ctx.fillStyle=colors.symbol; ctx.font='bold 18px monospace'; ctx.textAlign='center'; ctx.fillText(label,x,y+6)
    }
    ctx.globalAlpha=1
  }
  if (p.spark > 0) {
    ctx.globalAlpha = p.spark; ctx.fillStyle = colors.spark
    for (const [x, y, r] of [[65, 72, 10], [330, 56, 8], [352, 105, 5]]) {
      ctx.beginPath(); ctx.moveTo(x!, y! - r!); ctx.quadraticCurveTo(x!, y!, x! + r!, y!)
      ctx.quadraticCurveTo(x!, y!, x!, y! + r!); ctx.quadraticCurveTo(x!, y!, x! - r!, y!)
      ctx.quadraticCurveTo(x!, y!, x!, y! - r!); ctx.fill()
    }
    ctx.globalAlpha = 1
  }
}
