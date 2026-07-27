import { ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'

import type { TreeDir, TreeFile } from './file-tree'

/**
 * The Changes tab's file tree (spec #390: "file tree (left, folders collapsible, per-file ±)").
 * Pure presentation over `buildFileTree`'s data — clicking a file tells the parent, which
 * scrolls the diff; the tree itself owns nothing but its collapse state.
 */
export function ChangesTree({
  root,
  selected,
  onSelect,
}: {
  root: TreeDir
  selected: string | null
  onSelect: (path: string) => void
}) {
  return (
    <nav data-slot="changes-tree" aria-label="Changed files" className="min-w-0 text-[13px]">
      <ul className="flex flex-col gap-px">
        {root.dirs.map((dir) => (
          <DirNode key={dir.path} dir={dir} depth={0} selected={selected} onSelect={onSelect} />
        ))}
        {root.files.map((file) => (
          <FileNode key={file.path} file={file} depth={0} selected={selected} onSelect={onSelect} />
        ))}
      </ul>
    </nav>
  )
}

/** ±12/−3 in miniature — the tree's per-row counts (the aggregate label lives in the toolbar). */
function Counts({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] font-medium tabular-nums">
      {adds > 0 ? <span className="text-success">+{adds}</span> : null}
      {adds > 0 && dels > 0 ? ' ' : null}
      {dels > 0 ? <span className="text-danger">−{dels}</span> : null}
    </span>
  )
}

function DirNode({
  dir,
  depth,
  selected,
  onSelect,
}: {
  dir: TreeDir
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <li>
      <button
        type="button"
        data-slot="tree-dir"
        data-path={dir.path}
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
        <span className="min-w-0 truncate font-medium">{dir.name}</span>
        <Counts adds={dir.adds} dels={dir.dels} />
      </button>
      {open ? (
        <ul className="flex flex-col gap-px">
          {dir.dirs.map((child) => (
            <DirNode key={child.path} dir={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
          {dir.files.map((file) => (
            <FileNode key={file.path} file={file} depth={depth + 1} selected={selected} onSelect={onSelect} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/** The status tint mirrors the diff cards' badges: added grows, deleted shrinks. */
const statusTone: Partial<Record<TreeFile['status'], string>> = {
  added: 'text-success',
  deleted: 'text-danger',
}

function FileNode({
  file,
  depth,
  selected,
  onSelect,
}: {
  file: TreeFile
  depth: number
  selected: string | null
  onSelect: (path: string) => void
}) {
  const active = selected === file.path
  return (
    <li>
      <button
        type="button"
        data-slot="tree-file"
        data-path={file.path}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(file.path)}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left hover:bg-muted',
          active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
        style={{ paddingLeft: `${24 + depth * 14}px` }}
      >
        <FileIcon aria-hidden="true" className={cn('size-3.5 shrink-0', statusTone[file.status])} />
        <span className="min-w-0 truncate">{file.name}</span>
        <Counts adds={file.adds} dels={file.dels} />
      </button>
    </li>
  )
}
