import { ChevronRightIcon, FileIcon, FolderIcon, ImageIcon } from 'lucide-react'
import { useState } from 'react'

import { useRunFile } from '@/api/queries'
import { cn } from '@/lib/utils'

import { formatFileSize, isImagePath } from './worktree-files'

/**
 * The Files tab's worktree tree (R5 Step 1.6) — the lazy sibling of ChangesTree. The Changes
 * tree draws a payload it already has; here every directory is its own `GET /files?path=`
 * listing, fetched the first time the folder opens (react-query caches per path, so
 * re-opening is free). Folders therefore start CLOSED — an open-by-default tree would fan
 * out into one request per directory and defeat the lazy contract.
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
    <nav data-slot="files-tree" aria-label="Worktree files" className="min-w-0 text-[13px]">
      <ul className="flex flex-col gap-px">
        <DirChildren runId={runId} path="" depth={0} selected={selected} onSelect={onSelect} />
      </ul>
    </nav>
  )
}

/** One directory's rows — mounts (and thereby fetches) only while its parent is open. */
function DirChildren({
  runId,
  path,
  depth,
  selected,
  onSelect,
}: {
  runId: string
  path: string
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const entry = useRunFile(runId, path)

  if (entry.isPending) {
    return (
      <li data-slot="files-tree-loading" className="px-1.5 py-1 text-xs text-soft-foreground" style={{ paddingLeft: `${24 + depth * 14}px` }}>
        Loading…
      </li>
    )
  }
  if (entry.isError) {
    return (
      <li data-slot="files-tree-error" className="px-1.5 py-1 text-xs text-danger" style={{ paddingLeft: `${24 + depth * 14}px` }}>
        {entry.error.message}
      </li>
    )
  }
  if (entry.data.type !== 'dir') return null
  if (entry.data.entries.length === 0) {
    return (
      <li data-slot="files-tree-empty" className="px-1.5 py-1 text-xs text-soft-foreground" style={{ paddingLeft: `${24 + depth * 14}px` }}>
        Empty directory
      </li>
    )
  }

  // The server already sorts dirs-first, name-ascending — render verbatim.
  return (
    <>
      {entry.data.entries.map((child) =>
        child.type === 'dir' ? (
          <DirNode
            key={child.name}
            runId={runId}
            name={child.name}
            path={path === '' ? child.name : `${path}/${child.name}`}
            depth={depth}
            selected={selected}
            onSelect={onSelect}
          />
        ) : (
          <FileNode
            key={child.name}
            name={child.name}
            path={path === '' ? child.name : `${path}/${child.name}`}
            size={child.size}
            depth={depth}
            selected={selected}
            onSelect={onSelect}
          />
        ),
      )}
    </>
  )
}

function DirNode({
  runId,
  name,
  path,
  depth,
  selected,
  onSelect,
}: {
  runId: string
  name: string
  path: string
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button
        type="button"
        data-slot="files-dir"
        data-path={path}
        data-state={open ? 'open' : 'closed'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
        style={{ paddingLeft: `${6 + depth * 14}px` }}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{name}</span>
      </button>
      {open ? (
        <ul className="flex flex-col gap-px">
          <DirChildren runId={runId} path={path} depth={depth + 1} selected={selected} onSelect={onSelect} />
        </ul>
      ) : null}
    </li>
  )
}

function FileNode({
  name,
  path,
  size,
  depth,
  selected,
  onSelect,
}: {
  name: string
  path: string
  size: number | undefined
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const active = selected === path
  const Icon = isImagePath(path) ? ImageIcon : FileIcon
  return (
    <li>
      <button
        type="button"
        data-slot="files-file"
        data-path={path}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(path)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left hover:bg-muted',
          active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
        style={{ paddingLeft: `${24 + depth * 14}px` }}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{name}</span>
        {size !== undefined ? (
          <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] tabular-nums text-soft-foreground">
            {formatFileSize(size)}
          </span>
        ) : null}
      </button>
    </li>
  )
}
