import { MetricContent, metricSurface } from './presentation'
import type { DashboardCostProject, DashboardCosts } from '@open-mercato/cezar-api-client'
import { ArrowDownLeft, ArrowUpRight, DollarSign, ChevronRight } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type Metric = DashboardCosts['sort']
export const accents = {
  cost: {
    text: 'text-primary',
    fill: 'bg-primary',
    tint: 'from-primary/10',
    icon: DollarSign,
  },
  input: {
    text: 'text-violet',
    fill: 'bg-violet',
    tint: 'from-violet/10',
    icon: ArrowDownLeft,
  },
  output: {
    text: 'text-info',
    fill: 'bg-info',
    tint: 'from-info/10',
    icon: ArrowUpRight,
  },
}

export function CostMetricCard({
  metric,
  label,
  value,
  reported,
  total,
}: {
  metric: Metric
  label: string
  value: string
  reported: number
  total: number
}) {
  const accent = accents[metric]
  const Icon = accent.icon
  const coverage = total ? Math.min(100, (reported / total) * 100) : 0
  return (
    <div className={`${metricSurface} ${accent.tint}`}>
      <MetricContent
        label={label}
        value={value}
        icon={<Icon className={`size-4 ${accent.text}`} />}
      >
        {reported} of {total} tasks report this metric
      </MetricContent>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full rounded-full ${accent.fill} transition-[width] duration-300 motion-reduce:transition-none`}
          style={{ width: `${coverage}%` }}
        />
      </div>
    </div>
  )
}

export function CostProjectBars({
  projects,
  currentProjects,
  metric,
  field,
  label,
  format,
  onSelect,
}: {
  projects: DashboardCostProject[]
  currentProjects: DashboardCostProject[]
  metric: Metric
  field: 'costUsd' | 'inputTokens' | 'outputTokens'
  label: string
  format: (value: number | null | undefined) => string
  onSelect: (id: string) => void
}) {
  const maximum = projects.reduce(
    (max, project) => Math.max(max, project[field]?.value ?? 0),
    0,
  )
  const accent = accents[metric]
  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="space-y-1 rounded-xl border p-2"
        aria-label={`Projects ranked by ${label}`}
      >
        {projects.length === 0 && (
          <p className="px-3 py-4 text-muted-foreground">
            No projects to compare in this cohort.
          </p>
        )}
        {projects.slice(0, 5).map((project, index) => {
          const measure = project[field]
          const value = measure?.value
          const width = value == null || maximum === 0 ? 0 : (value / maximum) * 100
          const available = value != null
          return (
            <Tooltip key={project.projectId}>
              <TooltipTrigger asChild>
                <button
                  data-export-row
                  data-export-keep
                  className="group w-full rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none"
                  disabled={!currentProjects.some((p) => p.projectId === project.projectId)}
                  onClick={() => onSelect(project.projectId)}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 break-words font-medium">
                      {project.projectId}
                    </span>
                    <span className="shrink-0 font-semibold tabular-nums">{format(value)}</span>
                    <ChevronRight
                      data-export-exclude
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </div>
                  <div
                    className="mt-2 ml-7 h-2 overflow-hidden rounded-full bg-muted"
                    aria-hidden="true"
                  >
                    <div
                      data-project-bar={project.projectId}
                      className={`h-full rounded-full ${accent.fill} transition-[width] duration-300 motion-reduce:transition-none`}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <p className="mt-1.5 ml-7 text-xs text-muted-foreground">
                    {measure?.reportedTasks ?? 0} of {project.tasks} tasks report this metric
                    {!available ? ' · No measured value' : ''}
                  </p>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                <p className="font-medium">
                  {project.projectId} · {label}: {format(value)}
                </p>
                <p>
                  {measure?.reportedTasks ?? 0} of {project.tasks} tasks report this metric.
                </p>
                <p>Open project tasks</p>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      {projects.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {projects.length > 5 ? `Top 5 of ${projects.length} projects. ` : ''}
          Bar lengths compare reported values; the largest is the reference.
        </p>
      )}
    </TooltipProvider>
  )
}
