export const MASCOT_ACTIVITIES = ['idle', 'thinking', 'working', 'waiting', 'present', 'success', 'alert', 'walk', 'error'] as const
export type MascotActivity = typeof MASCOT_ACTIVITIES[number]

export interface MascotPose {
  bob: number; lean: number; left: number; right: number; leftFoot: number; rightFoot: number
  happy: number; blink: number; concerned: number; excited: number; laptop: number; spark: number; focused: number; typing: number; question: number; hourglass: number; orbit: number
}

/** Shared rig space is 400 × 400; angles are radians, time is seconds. */
export function mascotPose(activity: MascotActivity, time: number): MascotPose {
  const breath = Math.sin(time * Math.PI / 2)
  const p: MascotPose = { bob: -2 * breath, lean: 0, left: 0.025 * breath, right: -0.025 * breath,
    leftFoot: 0, rightFoot: 0, happy: 1, blink: 0, concerned: 0, excited: 0, laptop: 0, spark: 0, focused: 0, typing: 0, question: 0, hourglass: 0, orbit: 0 }
  const blink = time % 4.7
  if (blink > 4.35 && blink < 4.55) { p.happy = 0; p.blink = 1 }
  if (activity === 'thinking') { p.lean = -0.035; p.question = 1; p.right = 1.8 + 0.06 * breath; p.happy = 0; p.blink = 0; p.concerned = 1 }
  if (activity === 'waiting') { p.hourglass = 1; p.bob *= 0.5; p.happy = 0; p.blink = 1 }
  if (activity === 'error') { p.happy = 0; p.blink = 0; p.concerned = 1; p.lean = -0.025 }
  if (activity === 'working') { p.laptop = 1; p.happy = 0; p.blink = 0; p.focused = 1; p.typing = Math.sin(time * 13) * 2; p.right = 0.2 + Math.sin(time * 13) * 0.08; p.left = -0.15 + Math.sin(time * 13 + 1.8) * 0.06; p.lean = 0.018 * breath }
  if (activity === 'present') { p.orbit = 1; p.right = -1.25 + 0.13 * Math.sin(time * 2.3); p.left = -0.05 }
  if (activity === 'success' || activity === 'alert') {
    const bounce = Math.sin(Math.min(time / 1.2, 1) * Math.PI)
    p.bob = -15 * bounce; p.right = -1.7 * bounce; p.left = 0.25 * bounce
    p.happy = 0; p.blink = 0; p.excited = 1; p.spark = bounce
  }
  if (activity === 'walk') {
    const step = Math.sin(time * Math.PI * 2 / 1.2)
    p.leftFoot = Math.max(0, step) * -12; p.rightFoot = Math.max(0, -step) * -12
    p.bob = -Math.abs(step) * 4; p.lean = step * 0.025; p.left = step * 0.08; p.right = -step * 0.1
  }
  return p
}

/** Milliseconds between redraws once a blend settles: slow breathing states look the same at
 *  ~15 fps, so only typing, presenting, walking and reactions keep every frame (0). */
export function mascotFrameInterval(activity: MascotActivity): number {
  return activity === 'idle' || activity === 'thinking' || activity === 'waiting' || activity === 'error' ? 66 : 0
}

export function blendPose(from: MascotPose, to: MascotPose, amount: number): MascotPose {
  if (amount <= 0) return { ...from }
  if (amount >= 1) return { ...to }
  const result = { ...to }
  for (const key of Object.keys(to) as (keyof MascotPose)[]) result[key] = from[key] + (to[key] - from[key]) * amount
  return result
}
