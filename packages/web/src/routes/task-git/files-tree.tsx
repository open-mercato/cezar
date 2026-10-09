import { FileIcon, ImageIcon } from 'lucide-react'

import { useRunFile } from '@/api/queries'

import { TreeFileRow, TreeFolder, TreeNote, TreeRoot } from './tree-parts'
import { formatFileSize, isImagePath } from './worktree-files'

/**
 * The Files tab's worktree tree (R5 Step 1.6) — the lazy sibling of ChangesTree, drawn with the
 * same sidebar-style rows. The Changes tree draws a payload it already has; here every directory
 * is its own `GET /files?path=` listing, fetched the first time the folder opens (react-query
 * caches per path, so re-opening is free). Folders therefore start CLOSED — an open-by-default
 * tree would fan out into one request per directory and defeat the lazy contract.
 */
export function FilesTree({
  runId,
  selected,
  onSelect,
}: {
  runId: string
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <nav data-slot="files-tree" aria-label="Worktree files" className="min-w-0">
      <TreeRoot>
        <DirChildren runId={runId} path="" selected={selected} onSelect={onSelect} />
      </TreeRoot>
    </nav>
  )
}

type NodeProps = { runId: string; path: string; selected: string | null; onSelect: (path: string) => void }

/** One directory's rows — mounts (and thereby fetches) only while its parent is open. */
function DirChildren({ runId, path, selected, onSelect }: NodeProps) {
  const entry = useRunFile(runId, path)

  if (entry.isPending) return <TreeNote slot="files-tree-loading">Loading…</TreeNote>
  if (entry.isError) {
    return (
      <TreeNote slot="files-tree-error" tone="danger">
        {entry.error.message}
      </TreeNote>
    )
  }
  if (entry.data.type !== 'dir') return null
  if (entry.data.entries.length === 0) return <TreeNote slot="files-tree-empty">Empty directory</TreeNote>

  // The server already sorts dirs-first, name-ascending — render verbatim.
  return (
    <>
      {entry.data.entries.map((child) => {
        const childPath = path === '' ? child.name : `${path}/${child.name}`
        return child.type === 'dir' ? (
          <TreeFolder key={child.name} slot="files-dir" path={childPath} name={child.name} defaultOpen={false}>
            <DirChildren runId={runId} path={childPath} selected={selected} onSelect={onSelect} />
          </TreeFolder>
        ) : (
          <TreeFileRow
            key={child.name}
            slot="files-file"
            path={childPath}
            name={child.name}
            icon={
              isImagePath(childPath) ? (
                <ImageIcon aria-hidden="true" className="text-muted-foreground" />
              ) : (
                <FileIcon aria-hidden="true" className="text-muted-foreground" />
              )
            }
            active={selected === childPath}
            onSelect={onSelect}
            trailing={
              child.size !== undefined ? (
                <span className="font-mono text-xs tabular-nums text-soft-foreground">{formatFileSize(child.size)}</span>
              ) : null
            }
          />
        )
      })}
    </>
  )
}
