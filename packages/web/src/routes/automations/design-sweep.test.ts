import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The UI strategy rules this area applies (redesign 2026-11), pinned as a static scan so a
 * regression names its file and line: no native `<select>` (the Radix Select), no
 * `<input type="number">` (the IntegerStepper), no native `title=` on an HTML element (the one
 * Tooltip; an `aria-label` is fine), and no Tailwind palette colour (tokens only). The scan
 * covers the automations, inbox, workflows and workflow-graph routes.
 */

const ROUTES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AREA = [
  path.join(ROUTES, 'automations'),
  path.join(ROUTES, 'workflows'),
  path.join(ROUTES, 'workflow-graph'),
  path.join(ROUTES, 'inbox.tsx'),
]

interface Source {
  rel: string
  lines: string[]
}

function collect(entry: string, out: string[]): void {
  if (statSync(entry).isDirectory()) {
    for (const name of readdirSync(entry)) collect(path.join(entry, name), out)
    return
  }
  if (/\.(?:ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(entry)
}

/** Blank out comments, keeping line numbers, so a rule quoted in prose never trips the scan. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead: string) => lead + ' '.repeat(match.length - lead.length))
}

function sources(): Source[] {
  const files: string[] = []
  for (const entry of AREA) collect(entry, files)
  return files.sort().map((file) => ({
    rel: path.relative(ROUTES, file),
    lines: stripComments(readFileSync(file, 'utf8')).split('\n'),
  }))
}

function offenders(pattern: RegExp): string[] {
  const found: string[] = []
  for (const file of sources()) {
    file.lines.forEach((line, index) => {
      if (pattern.test(line)) found.push(`${file.rel}:${index + 1}: ${line.trim()}`)
    })
  }
  return found
}

/** `title=` on an HTML element (lowercase tag). A component's `title` prop is its own business. */
function nativeTitles(): string[] {
  const found: string[] = []
  for (const file of sources()) {
    const text = file.lines.join('\n')
    for (const match of text.matchAll(/\btitle=/g)) {
      const before = text.slice(0, match.index)
      const tags = [...before.matchAll(/<([A-Za-z][\w.-]*)/g)]
      const tag = tags.at(-1)?.[1]
      if (tag && /^[a-z]/.test(tag)) {
        const line = before.split('\n').length
        found.push(`${file.rel}:${line}: <${tag} … title=`)
      }
    }
  }
  return found
}

describe('UI strategy sweep — automations, inbox, workflows, workflow graph', () => {
  it('scans the area', () => {
    expect(sources().length).toBeGreaterThan(20)
  })

  it('has no native <select>: lists go through the Radix Select', () => {
    expect(offenders(/<select\b/)).toEqual([])
  })

  it('has no <input type="number">: whole numbers go through the IntegerStepper', () => {
    expect(offenders(/type=["']number["']/)).toEqual([])
  })

  it('puts no native title= on an HTML element: tooltips are the one Tooltip', () => {
    // A native title IS allowed to reveal truncated text (UI checklist): these are exactly the
    // truncation reveals main had — a new title anywhere else still fails here.
    const TRUNCATION_REVEALS = [
      'automations/automations-table.tsx <td>', // the trigger column
      'automations/calendar-parts.tsx <button>', // a week/day calendar block
      'workflow-graph/graph-node.tsx <span>', // an inner step's name and state
      'workflow-graph/graph-node.tsx <div>', // a square tile's name and detail
      'workflow-graph/workflow-graph.tsx <button>', // a palette node's description
      'workflow-graph/workflow-graph.tsx <button>', // a palette skill's description
    ]
    const found = nativeTitles().map((entry) => entry.replace(/:\d+: <(\w+) … title=$/, ' <$1>'))
    expect(found.sort()).toEqual(TRUNCATION_REVEALS.sort())
  })


  it('names no Tailwind palette colour: violet is the only accent, hues are tokens', () => {
    expect(offenders(/\b(?:text|bg|border|ring|fill|stroke)-(?:red|green|blue|amber|yellow|lime|emerald|orange|purple|indigo|sky|teal|slate|gray|zinc|neutral|stone)-\d{2,3}\b/)).toEqual([])
  })
})
