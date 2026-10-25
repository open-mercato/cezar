import type { CreateRunInput, TrackerItem } from '@open-mercato/cezar-api-client'

import { MAX_CHAIN_STEPS, skillChainSteps } from './github-task'

export const TRACKER_TASK_LIMIT = 100_000

export type TrackerPromptOptions = {
  skills?: readonly string[]
  supplemental?: string
  instruction?: string
}

export function trackerLosses(item: TrackerItem): string[] {
  const losses: string[] = []
  if (item.bodyTruncated) losses.push('The tracker description was truncated by the provider snapshot.')
  if (item.unsupportedContent) losses.push('The tracker item contains unsupported content that is absent from this snapshot.')
  return losses
}

export function trackerTaskPrompt(item: TrackerItem, options: TrackerPromptOptions = {}): string {
  const parts = [
    `Work on tracker ticket [${item.id}]: ${item.title}`,
    `Source: ${item.url}`,
    `Status: ${item.status}\nAuthor: ${item.author}\nLabels: ${item.labels.length ? item.labels.join(', ') : '(none)'}`,
    `Description:\n${item.body.trim() || '(No description was provided.)'}`,
    'Tracker snapshot scope: description only; comments, attachments, and custom fields are not included.',
  ]
  const losses = trackerLosses(item)
  if (losses.length) parts.push(`Snapshot limitations:\n${losses.map((loss) => `- ${loss}`).join('\n')}`)
  if (options.skills?.length) parts.push(`Use these skills where relevant: ${options.skills.join(', ')}.`)
  if (options.supplemental?.trim()) parts.push(`Supplemental context:\n${options.supplemental.trim()}`)
  if (options.instruction?.trim()) parts.push(options.instruction.trim())
  const task = parts.join('\n\n')
  if (task.length > TRACKER_TASK_LIMIT) {
    throw new Error('The final task exceeds the 100,000 character limit. Shorten the supplemental context or instruction.')
  }
  return task
}

export function trackerRunBody(
  item: TrackerItem,
  workflow: string | null,
  skills: readonly string[],
  backend: Pick<CreateRunInput, 'model' | 'runner' | 'agentProfile'>,
  options: TrackerPromptOptions & { acknowledgeLoss?: boolean },
): CreateRunInput {
  if (!workflow && skills.length > MAX_CHAIN_STEPS) {
    throw new Error(`A skill chain can contain at most ${MAX_CHAIN_STEPS} skills. Remove a skill before launching.`)
  }
  if (trackerLosses(item).length > 0 && !options.acknowledgeLoss) {
    throw new Error('Acknowledge the snapshot limitations before handing this issue to an agent.')
  }
  const task = trackerTaskPrompt(item, {
    ...options,
    skills: workflow ? skills : [],
  })
  if (workflow) return { ...backend, workflow, task }
  if (skills.length) return { ...backend, steps: skillChainSteps(skills), task }
  return { ...backend, workflow: 'quick-task', task }
}
