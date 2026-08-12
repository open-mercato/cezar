import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import { cn } from '@/lib/utils'

/**
 * GhostCodeBackdrop — the `/new` hero's second texture layer, behind the twinkles: faint
 * pseudo-code panels typed out character by character, as if an agent were quietly working in
 * the margins. Strictly decorative (aria-hidden, pointer-transparent, -z-10) and strictly
 * delicate: theme syntax tokens at ~0.3 opacity, masked out toward the bottom, and hidden
 * below `xl` where the side margins would collide with the composer column.
 *
 * Every loop composes a fresh scene: three snippets drawn from a multi-language pool
 * (TypeScript, Python, Rust, Go, SQL, CSS, a run log), each dropped into a random slot of a
 * different screen zone — the zones guarantee the picks never overlap each other or the
 * composer column. One author, so the blocks type strictly in sequence.
 *
 * The reveal itself is CSS (styles/index.css §ghost code) — this component only lays out the
 * lines and computes the typing schedule. The loop is a remount: at each scene's end the
 * `key` bumps, re-rolling the scene and restarting every animation after the CSS fade-out
 * has landed. Reduced motion renders one finished scene static and never schedules the timer.
 */

type GhostTone = 'key' | 'str' | 'fn' | 'com' | 'num'
type GhostToken = { text: string; tone?: GhostTone }
type GhostLine = GhostToken[]

const CHAR_MS = 38 // per-character typing speed
const LINE_PAUSE_MS = 280 // breath between lines, like a human reaching for the next thought
const BLOCK_PAUSE_MS = 900 // one author: each panel starts after the previous one finishes
const FIRST_KEYSTROKE_MS = 600
const HOLD_MS = 5500 // finished work lingers before the fade
const FADE_MS = 1400 // matches the tail of the CSS ghost-block-fade curve

const k = (text: string): GhostToken => ({ text, tone: 'key' })
const s = (text: string): GhostToken => ({ text, tone: 'str' })
const f = (text: string): GhostToken => ({ text, tone: 'fn' })
const c = (text: string): GhostToken => ({ text, tone: 'com' })
const n = (text: string): GhostToken => ({ text, tone: 'num' })
const p = (text: string): GhostToken => ({ text })

/** The snippet pool the imaginary agent writes from — one entry per language, all of them
 *  about the work this screen is about to start. Lines stay under ~46ch so every slot fits. */
const SNIPPETS: GhostLine[][] = [
  // TypeScript — the run loop itself
  [
    [c('// task accepted — isolating a worktree')],
    [k('const'), p(' tree = '), k('await'), p(' git.'), f('worktree'), p('(task.branch)')],
    [k('const'), p(' agent = '), f('spawn'), p('(runner, { tree, skills })')],
    [k('for await'), p(' ('), k('const'), p(' event '), k('of'), p(' agent.'), f('stream'), p('()) {')],
    [p('  cockpit.'), f('render'), p('(event)')],
    [p('}')],
  ],
  // the run log answering it
  [
    [p('$ cezar run '), s('--worktree --autonomous')],
    [s('✓'), p(' worktree ready · base '), s('main')],
    [s('✓'), p(' agent started')],
    [c('… editing src/routes/new-task.tsx')],
    [s('✓'), p(' tests green · '), n('+42 −7')],
    [s('✓'), p(' pull request opened')],
  ],
  // Python — taming a flaky test
  [
    [c('# flaky: replay before touching code')],
    [k('def'), p(' '), f('stabilize'), p('(test):')],
    [p('    '), k('for'), p(' attempt '), k('in'), p(' '), f('range'), p('('), n('3'), p('):')],
    [p('        '), k('if'), p(' '), f('run'), p('(test).ok:')],
    [p('            '), k('return'), p(' '), s("'green'")],
    [p('    '), k('return'), p(' '), f('quarantine'), p('(test)')],
  ],
  // Rust — applying the reviewed plan
  [
    [c('// apply the reviewed plan, step by step')],
    [k('let'), p(' diff = worktree.'), f('diff'), p('()?;')],
    [k('match'), p(' '), f('review'), p('(diff) {')],
    [p('    Ok(pr) => gh::'), f('open'), p('(pr),')],
    [p('    Err(e) => '), f('retry'), p('(e, backoff),')],
    [p('}')],
  ],
  // Go — merging once checks are green
  [
    [c('// merge when every check is green')],
    [k('func'), p(' '), f('merge'), p('(pr *PullRequest) '), k('error'), p(' {')],
    [p('    '), k('if'), p(' err := ci.'), f('Wait'), p('(pr); err != '), k('nil'), p(' {')],
    [p('        '), k('return'), p(' err')],
    [p('    }')],
    [p('    '), k('return'), p(' gh.'), f('Merge'), p('(pr)')],
    [p('}')],
  ],
  // SQL — the cockpit asking itself questions
  [
    [c('-- which branches ship the most?')],
    [k('select'), p(' branch, '), f('count'), p('(*) '), k('as'), p(' runs')],
    [k('from'), p(' tasks')],
    [k('where'), p(' status = '), s("'green'")],
    [k('group by'), p(' branch')],
    [k('order by'), p(' runs '), k('desc'), p(';')],
  ],
  // CSS — the composer's own glow
  [
    [c('/* the composer glow, one token deep */')],
    [p('.composer'), k(':focus-within'), p(' {')],
    [p('  border-color: '), f('var'), p('(--primary);')],
    [p('  box-shadow: '), n('0 0 0 3px'), p(' '), f('var'), p('(--ring);')],
    [p('  transition: box-shadow '), n('120ms'), p(' ease;')],
    [p('}')],
  ],
]

/** Position slots, grouped into non-overlapping screen zones: the left margin, the right
 *  margin, and the empty band under the suggestion chips. One slot is drawn per zone, so no
 *  two panels of a scene can collide — and none of them can touch the composer column. */
const ZONES: string[][] = [
  ['left-[3%] top-[12%]', 'left-[5%] top-[36%]', 'left-[8%] top-[58%]'],
  ['right-[3%] top-[14%]', 'right-[6%] top-[40%]', 'right-[4%] top-[62%]'],
  ['left-[28%] top-[66%]', 'left-[45%] top-[72%]', 'right-[26%] top-[70%]'],
]

const toneColor: Record<GhostTone, string> = {
  key: 'var(--syn-key)',
  str: 'var(--syn-str)',
  fn: 'var(--syn-fn)',
  com: 'var(--syn-com)',
  num: 'var(--syn-num)',
}

const lineLength = (line: GhostLine) =>
  line.reduce((total, token) => total + token.text.length, 0)

const blockTypeMs = (lines: GhostLine[]) =>
  lines.reduce((total, line) => total + lineLength(line) * CHAR_MS + LINE_PAUSE_MS, 0)

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

type SceneBlock = { lines: GhostLine[]; slot: string; startMs: number }
type Scene = { blocks: SceneBlock[]; cycleMs: number }

/** Roll one loop's worth of panels: a random snippet per zone, random slot within the zone,
 *  typed in shuffled order — so consecutive loops feel like different corners of the work. */
function buildScene(): Scene {
  const snippets = shuffle(SNIPPETS).slice(0, ZONES.length)
  const slots = shuffle(
    ZONES.map((zone) => zone[Math.floor(Math.random() * zone.length)] ?? ''),
  )
  let at = FIRST_KEYSTROKE_MS
  const blocks = snippets.map((lines, index) => {
    const startMs = at
    at += blockTypeMs(lines) + BLOCK_PAUSE_MS
    return { lines, slot: slots[index] ?? '', startMs }
  })
  return { blocks, cycleMs: at - BLOCK_PAUSE_MS + HOLD_MS + FADE_MS }
}

function GhostBlock({ block, cycleMs }: { block: SceneBlock; cycleMs: number }) {
  let at = block.startMs
  return (
    <div
      className={cn(
        'ghost-code-block absolute font-mono text-[11.5px] leading-[1.9] text-soft-foreground',
        block.slot,
      )}
      style={{ '--cycle': `${cycleMs}ms` } as CSSProperties}
    >
      {block.lines.map((line, index) => {
        const chars = lineLength(line)
        const delay = at
        at += chars * CHAR_MS + LINE_PAUSE_MS
        return (
          <div
            key={index}
            className="ghost-code-line"
            style={
              {
                '--n': chars,
                '--t': `${chars * CHAR_MS}ms`,
                '--d': `${delay}ms`,
              } as CSSProperties
            }
          >
            {line.map((token, tokenIndex) => (
              <span
                key={tokenIndex}
                style={token.tone ? { color: toneColor[token.tone] } : undefined}
              >
                {token.text}
              </span>
            ))}
          </div>
        )
      })}
    </div>
  )
}

const REDUCE_MOTION = '(prefers-reduced-motion: reduce)'

/** Live `prefers-reduced-motion`, inverted: the CSS half re-evaluates the moment the OS setting
 *  flips, so the loop timer has to follow it rather than read it once at mount — same
 *  subscription shape as `lib/use-desktop.ts`. Where `matchMedia` is missing (jsdom, SSR) the
 *  answer is "don't animate", so the suites never schedule a timer. */
function useMotionSafe(): boolean {
  const [motionSafe, setMotionSafe] = useState(
    () => typeof window.matchMedia === 'function' && !window.matchMedia(REDUCE_MOTION).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(REDUCE_MOTION)
    const onChange = (event: MediaQueryListEvent) => setMotionSafe(!event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return motionSafe
}

export function GhostCodeBackdrop() {
  const [cycle, setCycle] = useState(0)
  const motionSafe = useMotionSafe()
  // A fresh random scene each loop — `cycle` is the retrigger, not data the scene reads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scene = useMemo(() => buildScene(), [cycle])
  useEffect(() => {
    // Under reduced motion the CSS renders the scene static — re-rolling it would be churn.
    if (!motionSafe) return
    const id = window.setTimeout(() => setCycle((current) => current + 1), scene.cycleMs)
    return () => window.clearTimeout(id)
  }, [cycle, motionSafe, scene.cycleMs])
  return (
    <div
      data-slot="ghost-code-backdrop"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden max-xl:hidden [mask-image:linear-gradient(to_bottom,black_30%,transparent_96%)]"
    >
      {/* Remount wrapper: bumping the key restarts every CSS animation for the next loop. */}
      <div key={cycle} className="contents">
        {scene.blocks.map((block, index) => (
          <GhostBlock key={index} block={block} cycleMs={scene.cycleMs} />
        ))}
      </div>
    </div>
  )
}
