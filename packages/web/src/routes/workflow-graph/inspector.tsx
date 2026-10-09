import { ArrowRightIcon, CopyIcon, Trash2Icon } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { useSkills, useWorkflows } from '@/api/queries'
import type { WorkflowGraph, WorkflowGraphNode } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/components/ui/toaster'
import { forkBranchIds, portsOf, portTone, setForkBranches, targetOf, type GraphNodeType } from '@/lib/workflow-graph'

import { TONE } from './graph-node'

/**
 * The inspector: everything one node can be told, and where it leads (spec
 * 2026-09-30-workflow-node-editor). Two tabs — Settings is what you edit, Connections is what the
 * node hands on: its output ports with where each goes, and the template outputs later nodes can
 * quote. The fields themselves are one per node type, unchanged in what they write.
 */

const RUNNERS = ['claude', 'codex', 'opencode', 'cursor', 'pi'] as const

/** The agent's skill: a pick from the repo's skills, keeping any name the list does not know
 *  (a team skill not cached yet, or a file workflow from another repo) instead of erasing it. */
function SkillField({ value, onChange }: { value: string | undefined; onChange: (skill: string | undefined) => void }) {
  const skills = useSkills()
  const names = (skills.data ?? []).map((s) => s.name)
  const known = value === undefined || names.includes(value)
  return (
    <Field label="skill">
      <InspectorSelect
        value={value ?? ''}
        onChange={(v) => onChange(v || undefined)}
        options={[
          { value: '', label: 'no skill' },
          ...(!known && value !== undefined ? [{ value, label: `${value} (not in this repo)` }] : []),
          ...names.map((n) => ({ value: n, label: n })),
        ]}
      />
    </Field>
  )
}

/** A comma-separated list edited as text, committed on blur. */
function ListField({ label, value, onChange }: { label: string; value: string[] | undefined; onChange: (v: string[] | undefined) => void }) {
  return (
    <Field label={label}>
      <Input
        defaultValue={value?.join(', ') ?? ''}
        onBlur={(e) => {
          const list = e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
          onChange(list.length ? list : undefined)
        }}
        className="text-[13px]"
      />
    </Field>
  )
}

/** A saved workflow picked by name — the catalog the task composer offers. */
function WorkflowSelect({
  label,
  value,
  optional,
  onChange,
}: {
  label: string
  value: string | undefined
  optional?: boolean
  onChange: (name: string | undefined) => void
}) {
  const workflows = useWorkflows()
  const names = (workflows.data?.workflows ?? []).map((w) => w.name)
  return (
    <InspectorSelect
      aria-label={label}
      value={value ?? ''}
      onChange={(v) => onChange(v || undefined)}
      options={[
        ...(optional ? [{ value: '', label: 'one agent step' }] : []),
        ...(value && !names.includes(value) ? [{ value, label: `${value} (not found)` }] : []),
        ...names.map((n) => ({ value: n, label: n })),
      ]}
    />
  )
}

type ConditionValue = Extract<WorkflowGraphNode, { type: 'if' }>['condition']

/** An `if` node's condition: pick what to look at, then the fields that kind needs. */
function ConditionEditor({ condition, onChange }: { condition: ConditionValue; onChange: (c: ConditionValue) => void }) {
  const numericOps = ['>', '>=', '<', '<=', '=='] as const
  const outputOps = ['equals', 'not-equals', 'contains', '>', '>=', '<', '<='] as const
  const switchKind = (kind: ConditionValue['kind']) => {
    switch (kind) {
      case 'diff-lines':
      case 'diff-files':
        return onChange({ kind, op: '>', value: kind === 'diff-lines' ? 500 : 20 })
      case 'paths-changed':
        return onChange({ kind, glob: 'packages/web/**' })
      case 'output':
        return onChange({ kind, ref: 'review.verdict', op: 'equals', value: 'approve' })
      case 'branch':
        return onChange({ kind, op: 'equals', value: 'main' })
    }
  }
  return (
    <>
      <Field label="look at">
        <InspectorSelect
          value={condition.kind}
          onChange={(v) => switchKind(v as ConditionValue['kind'])}
          options={[
            { value: 'diff-lines', label: "the task's diff — changed lines" },
            { value: 'diff-files', label: "the task's diff — changed files" },
            { value: 'paths-changed', label: 'which paths changed (glob)' },
            { value: 'output', label: "another node's output" },
            { value: 'branch', label: 'the base branch' },
          ]}
        />
      </Field>
      {(condition.kind === 'diff-lines' || condition.kind === 'diff-files') && (
        <div className="grid grid-cols-[5rem_1fr] gap-2">
          <InspectorSelect
            aria-label="operator"
            value={condition.op}
            onChange={(v) => onChange({ ...condition, op: v as (typeof numericOps)[number] })}
            options={numericOps.map((o) => ({ value: o, label: o }))}
          />
          <Input type="number" min={0} aria-label="threshold" value={condition.value} onChange={(e) => onChange({ ...condition, value: Math.max(0, Number(e.target.value) || 0) })} className="text-[13px]" />
        </div>
      )}
      {condition.kind === 'paths-changed' && (
        <Field label="glob — * within a folder, ** across folders">
          <Input value={condition.glob} onChange={(e) => onChange({ ...condition, glob: e.target.value })} className="font-mono text-xs" />
        </Field>
      )}
      {condition.kind === 'output' && (
        <>
          <Field label="output — <node>.<field>">
            <Input value={condition.ref} onChange={(e) => onChange({ ...condition, ref: e.target.value.trim() })} className="font-mono text-xs" />
          </Field>
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <InspectorSelect
              aria-label="operator"
              value={condition.op}
              onChange={(v) => onChange({ ...condition, op: v as (typeof outputOps)[number] })}
              options={outputOps.map((o) => ({ value: o, label: o }))}
            />
            <Input aria-label="value" value={String(condition.value)} onChange={(e) => onChange({ ...condition, value: e.target.value })} className="text-[13px]" />
          </div>
        </>
      )}
      {condition.kind === 'branch' && (
        <div className="grid grid-cols-[7rem_1fr] gap-2">
          <InspectorSelect
            aria-label="operator"
            value={condition.op}
            onChange={(v) => onChange({ ...condition, op: v as 'equals' | 'matches' })}
            options={[
              { value: 'equals', label: 'equals' },
              { value: 'matches', label: 'matches glob' },
            ]}
          />
          <Input aria-label="branch" value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })} className="font-mono text-xs" />
        </div>
      )}
      <Note>Leaves by true or false. Diff and paths are this task's own changes vs its base.</Note>
    </>
  )
}

/**
 * One labelled field. The labels arrive as "name — what it means": the name is the label, and
 * what follows the dash is set under the control as its hint, where it explains without shouting.
 * Still ONE `<label>` around the control, so the whole string stays its accessible name.
 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  const cut = label.indexOf(' — ')
  const title = cut < 0 ? label : label.slice(0, cut)
  // Capitalised by hand, and only when it starts with a letter: a hint that opens with a token
  // (`{{task}}`) must stay exactly as it is typed.
  const rest = cut < 0 ? null : label.slice(cut + 3)
  const hint = rest && /^[a-z]/.test(rest) ? rest[0]!.toUpperCase() + rest.slice(1) : rest
  return (
    <Label className="flex flex-col items-stretch gap-1.5 text-[13px] leading-normal font-normal select-auto">
      <span className="text-xs font-medium text-foreground first-letter:uppercase">
        {title}
        {hint ? <span className="sr-only"> — {hint}</span> : null}
      </span>
      {children}
      {hint ? (
        <span aria-hidden="true" className="text-xs text-pretty text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </Label>
  )
}

/** A note under a group of fields: how the node behaves, in a sentence or two. */
function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-pretty text-muted-foreground">{children}</p>
}

/** Radix forbids an empty-string item value, so the "none / inherit" option travels as a sentinel. */
const NONE_VALUE = '__none'

/** The inspector's one select: the same `''`-means-unset contract the native element had. */
function InspectorSelect({
  value,
  onChange,
  options,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  'aria-label'?: string
}) {
  return (
    <Select value={value === '' ? NONE_VALUE : value} onValueChange={(v) => onChange(v === NONE_VALUE ? '' : v)}>
      <SelectTrigger aria-label={ariaLabel} className="w-full min-w-0 px-2.5 text-[13px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value === '' ? NONE_VALUE : o.value} className="text-[13px]">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A duration edited in minutes, stored in ms (min 1 minute — the server's floor). */
function MinutesField({
  label,
  value,
  optional,
  onChange,
}: {
  label: string
  value: number | undefined
  optional?: boolean
  onChange: (ms: number | undefined) => void
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={1}
        value={value ? Math.round(value / 60_000) : ''}
        placeholder={optional ? 'no timeout' : undefined}
        onChange={(e) => {
          const minutes = Math.floor(Number(e.target.value))
          onChange(minutes >= 1 ? minutes * 60_000 : undefined)
        }}
        className="text-[13px]"
      />
    </Field>
  )
}

const OUTPUTS: Record<GraphNodeType, string[]> = {
  start: [],
  end: [],
  loop: ['iteration', 'max'],
  agent: ['summary', 'verdict', 'costUsd'],
  check: ['exitCode', 'output'],
  'gate.human': ['comment'],
  'ask-user': ['answer'],
  dispatch: ['runId', 'status', 'summary'],
  'git.commit': ['sha'],
  'github.draft-pr': ['url', 'number'],
  'github.wait-ci': ['status'],
  'github.pr-comment': [],
  fork: ['runIds'],
  join: ['succeeded', 'failed'],
  workflow: ['runId', 'status', 'summary'],
  if: ['result', 'value'],
  'git.push': [],
  'git.sync-base': ['conflicts'],
  'github.pr-update': [],
  'github.issue-comment': ['issue'],
  'notify.webhook': ['status'],
}

/** A node's template outputs — a fork's agent reports as a subtask (`runId`, `status`, `summary`). */
function outputsOf(node: WorkflowGraphNode, branches?: ReadonlySet<string>): string[] {
  if (node.type === 'agent' && branches?.has(node.id)) return ['runId', 'status', 'summary']
  return OUTPUTS[node.type]
}

export function Inspector({
  node,
  graph,
  onChange,
  onGraphEdit,
  onDelete,
  onSelectNode,
}: {
  node: WorkflowGraphNode
  graph: WorkflowGraph
  onChange: (next: WorkflowGraphNode) => void
  /** Edits that reach past this node (a fork's branch count adds or drops agents). */
  onGraphEdit: (fn: (g: WorkflowGraph) => WorkflowGraph) => void
  onDelete: () => void
  /** Jump to another node — a port's target, from the Connections tab. */
  onSelectNode: (id: string) => void
}) {
  const branches = forkBranchIds(graph)
  const isBranch = node.type === 'agent' && branches.has(node.id)
  // The id is committed on blur so a half-typed rename never rewires the graph mid-word.
  const [draftId, setDraftId] = useState(node.id)
  const set = (patch: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...node, ...patch }
    for (const [k, v] of Object.entries(patch)) if (v === undefined || v === '') delete next[k]
    onChange(next as WorkflowGraphNode)
  }

  const ports = portsOf(node)
  const outputs = outputsOf(node, branches)
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
    toast(`Copied ${text}`)
  }

  return (
    <Tabs defaultValue="settings" className="flex h-full min-h-0 flex-col gap-0">
      <TabsList variant="line" className="h-10 w-full shrink-0 justify-start gap-4 border-b border-border/70 px-4">
        <TabsTrigger value="settings" className="flex-none px-0 text-[13px]">
          Settings
        </TabsTrigger>
        <TabsTrigger value="connections" className="flex-none px-0 text-[13px]">
          Connections
          <span className="ml-1 text-xs text-muted-foreground tabular-nums">{ports.length}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto">
    <div className="flex flex-col gap-4 p-4 text-[13px]">
      <div className="grid grid-cols-2 gap-2">
      <Field label="name">
        <Input value={node.name ?? ''} onChange={(e) => set({ name: e.target.value })} className="text-[13px]" />
      </Field>
      <Field label="id">
        <Input
          value={draftId}
          onChange={(e) => setDraftId(e.target.value)}
          onBlur={() => {
            const id = draftId.trim()
            if (!id || id === node.id) return setDraftId(node.id)
            if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || graph.nodes.some((n) => n.id === id)) {
              toast(`“${id}” is taken or not a valid id (letters, digits, - and _).`, { tone: 'danger' })
              return setDraftId(node.id)
            }
            onChange({ ...node, id })
          }}
          className="text-[13px]"
        />
      </Field>
      </div>

      {node.type === 'agent' && (
        <>
          <Field label="prompt — {{task}}, {{nodes.<id>.<field>}}">
            <Textarea value={node.prompt ?? ''} rows={5} className="font-mono text-xs" onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <SkillField value={node.skill} onChange={(skill) => set({ skill })} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="runner">
              <InspectorSelect
                value={node.runner ?? ''}
                onChange={(v) => set({ runner: v || undefined })}
                options={[{ value: '', label: 'task default' }, ...RUNNERS.map((r) => ({ value: r, label: r }))]}
              />
            </Field>
            <Field label="model">
              <Input value={node.model ?? ''} onChange={(e) => set({ model: e.target.value })} className="text-[13px]" />
            </Field>
          </div>
          {isBranch ? (
            <>
              <Label className="text-[13px] leading-normal font-normal">
                <Checkbox
                  checked={node.review ?? false}
                  onCheckedChange={(checked) => set({ review: checked === true || undefined })}
                />
                reviewer — judges the task branch, never implements
              </Label>
              <Field label="budget USD — carved from this run">
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={node.budgetUsd ?? ''}
                  onChange={(e) => set({ budgetUsd: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                  className="text-[13px]"
                />
              </Field>
              <Note>
                A fork branch: runs as its own subtask at the same time as the other branches — a fresh session in its
                own worktree, starting from the task's work so far.
              </Note>
            </>
          ) : (
            <>
              <Field label="verdicts — comma-separated, each becomes a port">
                <Input
                  defaultValue={node.verdicts?.join(', ') ?? ''}
                  onBlur={(e) => {
                    const list = e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
                    set({ verdicts: list.length ? list : undefined })
                  }}
                  className="text-[13px]"
                  placeholder="approve, changes"
                />
              </Field>
              <Field label="session">
                <InspectorSelect
                  value={node.session?.continue ?? ''}
                  onChange={(v) => set({ session: v ? { continue: v } : undefined })}
                  options={[
                    { value: '', label: 'fresh session' },
                    ...graph.nodes
                      .filter((n) => n.type === 'agent' && n.id !== node.id)
                      .map((n) => ({ value: n.id, label: `continue ${n.name ?? n.id}` })),
                  ]}
                />
              </Field>
            </>
          )}
          {node.verdicts?.length ? (
            <Note>
              The agent ends its turn with {node.verdicts.map((v) => `CEZ:VERDICT ${v}`).join(' or ')}. No verdict → one
              reminder, then <span style={{ color: TONE.failure }}>failed</span>.
            </Note>
          ) : null}
        </>
      )}

      {node.type === 'check' && (
        <Field label="command — runs in the worktree; exit 0 passes">
          <Textarea value={node.command} rows={3} className="font-mono text-xs" onChange={(e) => set({ command: e.target.value })} />
        </Field>
      )}

      {node.type === 'loop' && (
        <Field label="max iterations — repeat while within, then exhausted">
          <Input
            type="number"
            min={1}
            value={node.max}
            onChange={(e) => set({ max: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
            className="text-[13px]"
          />
        </Field>
      )}

      {node.type === 'gate.human' && (
        <>
          <Field label="message — shown on the approve / reject card">
            <Textarea value={node.message} rows={3} onChange={(e) => set({ message: e.target.value })} />
          </Field>
          <MinutesField label="timeout (minutes, optional) — adds a timeout port" value={node.timeoutMs} optional onChange={(ms) => set({ timeoutMs: ms })} />
          <Note>
            The run waits without holding a slot. A reply starting with “approve” takes approve; anything else takes
            reject and becomes <code>{`{{nodes.${node.id}.comment}}`}</code>.
          </Note>
        </>
      )}

      {node.type === 'ask-user' && (
        <>
          <Field label="question">
            <Textarea value={node.question} rows={3} onChange={(e) => set({ question: e.target.value })} />
          </Field>
          <Field label="options — comma-separated, optional (free text always works)">
            <Input
              defaultValue={node.options?.join(', ') ?? ''}
              onBlur={(e) => {
                const list = e.target.value.split(',').map((v) => v.trim()).filter(Boolean)
                set({ options: list.length ? list : undefined })
              }}
              className="text-[13px]"
            />
          </Field>
          <MinutesField label="timeout (minutes, optional) — adds a timeout port" value={node.timeoutMs} optional onChange={(ms) => set({ timeoutMs: ms })} />
        </>
      )}

      {node.type === 'dispatch' && (
        <>
          <Field label="objective — {{task}}, {{nodes.<id>.<field>}}">
            <Textarea value={node.prompt} rows={4} className="font-mono text-xs" onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="runner">
              <InspectorSelect
                value={node.runner ?? ''}
                onChange={(v) => set({ runner: v || undefined })}
                options={[{ value: '', label: 'task default' }, ...RUNNERS.map((r) => ({ value: r, label: r }))]}
              />
            </Field>
            <Field label="budget USD">
              <Input
                type="number"
                min={0}
                step={0.5}
                value={node.budgetUsd ?? ''}
                onChange={(e) => set({ budgetUsd: Number(e.target.value) > 0 ? Number(e.target.value) : undefined })}
                className="text-[13px]"
              />
            </Field>
          </div>
        </>
      )}

      {node.type === 'git.commit' && (
        <Field label="commit message — commits everything in the worktree">
          <Input value={node.message} onChange={(e) => set({ message: e.target.value })} className="text-[13px]" />
        </Field>
      )}

      {node.type === 'github.draft-pr' && (
        <Field label="title — optional, defaults to the task title">
          <Input value={node.title ?? ''} onChange={(e) => set({ title: e.target.value })} className="text-[13px]" />
        </Field>
      )}

      {node.type === 'github.pr-comment' && (
        <Field label="comment body">
          <Textarea value={node.body} rows={3} onChange={(e) => set({ body: e.target.value })} />
        </Field>
      )}

      {node.type === 'github.wait-ci' && (
        <>
          <MinutesField label="timeout (minutes) — required" value={node.timeoutMs} onChange={(ms) => set({ timeoutMs: ms ?? 60 * 60_000 })} />
          <Field label="poll every (seconds)">
            <Input
              type="number"
              min={10}
              value={Math.round(node.pollMs / 1000)}
              onChange={(e) => set({ pollMs: Math.max(10, Math.floor(Number(e.target.value) || 60)) * 1000 })}
              className="text-[13px]"
            />
          </Field>
        </>
      )}

      {node.type === 'fork' && (
        <>
          <Field label="branches — one agent each, all at once">
            <InspectorSelect
              value={String(node.branches)}
              onChange={(v) => onGraphEdit((g) => setForkBranches(g, node.id, Number(v)))}
              options={[2, 3, 4].map((n) => ({ value: String(n), label: `${n} agents` }))}
            />
          </Field>
          <Note>
            Each branch is the agent it is wired to: set its prompt, runner and budget there. They run as subtasks in
            their own worktrees (at most 4 at once) and meet at the join.
          </Note>
        </>
      )}

      {node.type === 'join' && (
        <Field label="wait for">
          <InspectorSelect
            value={node.wait}
            onChange={(v) => set({ wait: v })}
            options={[
              { value: 'all', label: 'every branch (done only if all succeed)' },
              { value: 'any', label: 'the first to succeed (the rest are cancelled)' },
            ]}
          />
        </Field>
      )}

      {node.type === 'workflow' && (
        <>
          <WorkflowSelect label="workflow to run" value={node.workflow} onChange={(workflow) => set({ workflow: workflow ?? 'quick-task' })} />
          <Field label="task for it — {{task}}, {{nodes.<id>.<field>}}">
            <Textarea value={node.prompt ?? ''} placeholder="{{task}}" rows={3} className="font-mono text-xs" onChange={(e) => set({ prompt: e.target.value })} />
          </Field>
          <Note>Runs as a subtask in its own worktree; this node waits for it.</Note>
        </>
      )}

      {node.type === 'git.push' && (
        <Note>Commits anything pending, then pushes the task branch to origin.</Note>
      )}

      {node.type === 'git.sync-base' && (
        <Note>
          Merges the latest base branch into the task. On a conflict the merge is left in progress and the node leaves by{' '}
          <span style={{ color: TONE.failure }}>conflict</span> — wire it to an agent to resolve it;{' '}
          <code>{`{{nodes.${node.id}.conflicts}}`}</code> lists the files.
        </Note>
      )}

      {node.type === 'github.pr-update' && (
        <>
          <Label className="text-[13px] leading-normal font-normal">
            <Checkbox checked={node.ready ?? false} onCheckedChange={(checked) => set({ ready: checked === true || undefined })} />
            <span>mark ready for review</span>
          </Label>
          <ListField label="add labels — comma-separated" value={node.addLabels} onChange={(addLabels) => set({ addLabels })} />
          <ListField label="request reviewers — comma-separated logins" value={node.reviewers} onChange={(reviewers) => set({ reviewers })} />
        </>
      )}

      {node.type === 'github.issue-comment' && (
        <>
          <Field label="issue number — empty = the task's own issue">
            <Input
              type="number"
              min={1}
              value={node.issue ?? ''}
              onChange={(e) => set({ issue: Number(e.target.value) > 0 ? Math.floor(Number(e.target.value)) : undefined })}
              className="text-[13px]"
            />
          </Field>
          <Field label="comment">
            <Textarea value={node.body} rows={3} onChange={(e) => set({ body: e.target.value })} />
          </Field>
        </>
      )}

      {node.type === 'notify.webhook' && (
        <>
          <Field label="URL (http/https)">
            <Input value={node.url} onChange={(e) => set({ url: e.target.value })} className="font-mono text-xs" />
          </Field>
          <Field label="message — sent as JSON text">
            <Textarea value={node.body ?? ''} rows={3} onChange={(e) => set({ body: e.target.value })} />
          </Field>
          <Note>
            Only runs when the server has <code>CEZ_WORKFLOW_WEBHOOKS=1</code>; otherwise it leaves by failed.
          </Note>
        </>
      )}

      {node.type === 'if' && <ConditionEditor condition={node.condition} onChange={(condition) => set({ condition })} />}

      {node.type === 'end' && (
        <Field label="run status">
          <InspectorSelect
            value={node.status}
            onChange={(v) => set({ status: v })}
            options={[
              { value: 'success', label: 'success' },
              { value: 'failed', label: 'failed' },
            ]}
          />
        </Field>
      )}

    </div>
      </TabsContent>
      <TabsContent value="connections" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-5 p-4 text-[13px]">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-foreground">Output ports</h3>
            {ports.length === 0 ? (
              <p className="text-xs text-muted-foreground">This node ends the run — nothing leaves it.</p>
            ) : (
              <ul className="flex flex-col overflow-hidden rounded-lg border border-border/70">
                {ports.map((port) => {
                  const to = targetOf(graph, node.id, port)
                  const target = to ? graph.nodes.find((n) => n.id === to) : undefined
                  return (
                    <li key={port} className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5 text-xs last:border-b-0">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: TONE[portTone(node, port)] }} />
                      <span className="min-w-0 truncate font-medium" style={{ color: TONE[portTone(node, port)] }}>
                        {port}
                      </span>
                      <ArrowRightIcon aria-hidden="true" className="ml-auto size-3 shrink-0 text-soft-foreground" />
                      {to ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="max-w-[55%] px-1.5 text-foreground"
                          title={`Go to ${target?.name ?? to}`}
                          onClick={() => onSelectNode(to)}
                        >
                          <span className="truncate">{target?.name ?? to}</span>
                        </Button>
                      ) : (
                        <span className="px-1.5 text-muted-foreground">ends run</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            <p className="text-xs text-pretty text-muted-foreground">
              Drag from a port's dot to wire it, or use its + on the canvas. An unwired port ends the run.
            </p>
          </section>
          {outputs.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-foreground">Outputs for templates</h3>
              <div className="flex flex-col gap-1">
                {outputs.map((output) => {
                  const token = `{{nodes.${node.id}.${output}}}`
                  return (
                    <Button
                      key={output}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="group/token h-7 justify-between gap-2 px-2 font-mono text-[11px] font-normal text-muted-foreground"
                      title="Copy — paste it into a later node's prompt"
                      onClick={() => copy(token)}
                    >
                      <span className="truncate">{token}</span>
                      <CopyIcon aria-hidden="true" className="size-3 shrink-0 opacity-0 group-hover/token:opacity-100" />
                    </Button>
                  )
                })}
              </div>
              <p className="text-xs text-pretty text-muted-foreground">
                What later nodes can quote in a prompt, a message or a condition.
              </p>
            </section>
          ) : null}
        </div>
      </TabsContent>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-4 py-2.5">
        <span className="truncate font-mono text-[11px] text-soft-foreground" title={`${node.type} node`}>
          {node.type}
        </span>
        <Button size="sm" variant="danger-ghost" onClick={onDelete} aria-label="Delete node">
          <Trash2Icon /> Delete node
        </Button>
      </div>
    </Tabs>
  )
}
