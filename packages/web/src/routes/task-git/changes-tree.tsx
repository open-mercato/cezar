import { FileIcon } from 'lucide-react'
import { createContext, useContext } from 'react'

import { CommentCount } from '@/components/comment-count'

import type { TreeDir, TreeFile } from './file-tree'
import { StatusLetter, TreeCounts, TreeFileRow, TreeFolder, TreeRoot } from './tree-parts'

/**
 * The Changes tab's file tree (spec #390: "file tree (left, folders collapsible, per-file ±)").
 * Pure presentation over `buildFileTree`'s data — clicking a file tells the parent, which
 * scrolls the diff; the tree itself owns nothing but its collapse state. Drawn with the shared
 * sidebar-style rows (tree-parts.tsx), so it reads the same in the Git screen's contextual
 * sidebar and inside a task workspace column.
 */
export function ChangesTree({
  root,
  selected,
  onSelect,
  commentCounts = NO_COMMENTS,
}: {
  root: TreeDir
  selected: string | null
  onSelect: (path: string) => void
  /** Drafted line comments per file path (the self-review flow) — shown on the file's row, and
   *  summed on a COLLAPSED folder, whose files' own counts are hidden. */
  commentCounts?: ReadonlyMap<string, number>
}) {
  return (
    <CommentCountsContext.Provider value={commentCounts}>
      <nav data-slot="changes-tree" aria-label="Changed files" className="min-w-0">
        <TreeRoot>
          <DirChildren dir={root} selected={selected} onSelect={onSelect} />
        </TreeRoot>
      </nav>
    </CommentCountsContext.Provider>
  )
}

const NO_COMMENTS: ReadonlyMap<string, number> = new Map()
/** Context rather than one more prop down the recursion — only the leaf badges read it. */
const CommentCountsContext = createContext<ReadonlyMap<string, number>>(NO_COMMENTS)

function dirCommentCount(dir: TreeDir, counts: ReadonlyMap<string, number>): number {
  let total = 0
  for (const file of dir.files) total += counts.get(file.path) ?? 0
  for (const child of dir.dirs) total += dirCommentCount(child, counts)
  return total
}

type NodeProps = { selected: string | null; onSelect: (path: string) => void }

function DirChildren({ dir, selected, onSelect }: NodeProps & { dir: TreeDir }) {
  return (
    <>
      {dir.dirs.map((child) => (
        <DirNode key={child.path} dir={child} selected={selected} onSelect={onSelect} />
      ))}
      {dir.files.map((file) => (
        <FileNode key={file.path} file={file} selected={selected} onSelect={onSelect} />
      ))}
    </>
  )
}

function DirNode({ dir, selected, onSelect }: NodeProps & { dir: TreeDir }) {
  const counts = useContext(CommentCountsContext)
  return (
    <TreeFolder
      slot="tree-dir"
      path={dir.path}
      name={dir.name}
      defaultOpen
      // Only while collapsed: an open folder's files show their own counts, so totals here would
      // just repeat them (and cost the name its room). Collapsed, the row says what it holds.
      trailing={(open) =>
        open ? null : (
          <>
            <CommentCount count={dirCommentCount(dir, counts)} />
            <TreeCounts adds={dir.adds} dels={dir.dels} />
          </>
        )
      }
    >
      <DirChildren dir={dir} selected={selected} onSelect={onSelect} />
    </TreeFolder>
  )
}

function FileNode({ file, selected, onSelect }: NodeProps & { file: TreeFile }) {
  const comments = useContext(CommentCountsContext).get(file.path) ?? 0
  return (
    <TreeFileRow
      slot="tree-file"
      path={file.path}
      name={file.name}
      icon={<FileIcon aria-hidden="true" className="text-muted-foreground" />}
      active={selected === file.path}
      onSelect={onSelect}
      trailing={
        <>
          <CommentCount count={comments} />
          <TreeCounts adds={file.adds} dels={file.dels} />
          <StatusLetter status={file.status} />
        </>
      }
    />
  )
}
