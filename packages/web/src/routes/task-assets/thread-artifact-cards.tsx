import { FileCodeIcon, FileIcon, FileJsonIcon, FileTextIcon, ImageIcon } from 'lucide-react'
import type { ComponentType } from 'react'

import { useRunArtifacts } from '@/api/queries'
import type { RunArtifact } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/project-router'

import { artifactLabel, byNewest, KIND_LABELS } from './assets-model'

const KIND_ICONS: Record<RunArtifact['kind'], ComponentType<{ className?: string }>> = {
  html: FileCodeIcon,
  markdown: FileTextIcon,
  image: ImageIcon,
  json: FileJsonIcon,
  other: FileIcon,
}

/** How many cards the thread shows before pointing at the Assets view for the rest. */
const SHOWN = 3

/**
 * "The moment an artifact appears" (spec 2026-10-22-html-artifacts-and-impact § UI/UX): a card per
 * published file, derived from the run's artifact listing so it survives a reload. Placed after the
 * transcript, oldest first: a file is produced by the conversation so far, and the listing carries
 * no turn to pin it to.
 */
export function ThreadArtifactCards({ runId }: { runId: string }) {
  const listing = useRunArtifacts(runId)
  const artifacts = listing.data?.artifacts ?? []
  if (artifacts.length === 0) return null
  const newest = byNewest(artifacts)
  const shown = newest.slice(0, SHOWN).reverse()
  const more = artifacts.length - shown.length
  return (
    <div data-slot="thread-artifacts" className="flex flex-col gap-2 py-2">
      {shown.map((artifact) => {
        const Icon = KIND_ICONS[artifact.kind]
        const href = `/tasks/${runId}/assets/${encodeURIComponent(artifact.name)}`
        return (
          <div
            key={artifact.name}
            data-slot="thread-artifact-card"
            data-artifact={artifact.name}
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">{artifactLabel(artifact)}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {KIND_LABELS[artifact.kind]} · {artifact.name}
              </span>
            </span>
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to={href} data-action="open-artifact" aria-label={`Open ${artifactLabel(artifact)} in Assets`}>
                Open
              </Link>
            </Button>
          </div>
        )
      })}
      {more > 0 ? (
        <Link
          to={`/tasks/${runId}/assets`}
          data-action="open-assets"
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {more} more in Assets
        </Link>
      ) : null}
    </div>
  )
}
