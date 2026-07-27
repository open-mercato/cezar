import type { ChangedFile } from '@open-mercato/cezar-api-client'

/**
 * The Changes tab's file tree, as pure data (R5 Step 1.5): changed paths → nested folders
 * with per-folder ± aggregates, dirs first, single-child folder chains compacted the way
 * forges render them (`packages/web/src → one row`) so a deep monorepo path doesn't cost six
 * indent levels. The component (changes-tree.tsx) only draws this.
 */

export interface TreeFile {
  kind: 'file'
  /** Display name (the path's last segment). */
  name: string
  /** Full repo-relative path — the diff anchor the click scrolls to. */
  path: string
  status: ChangedFile['status']
  adds: number
  dels: number
  binary: boolean
}

export interface TreeDir {
  kind: 'dir'
  /** Display name; compacted chains keep their joined path ("packages/web/src"). */
  name: string
  /** Full path from the root ('' for the root itself). */
  path: string
  dirs: TreeDir[]
  files: TreeFile[]
  /** Aggregates over every file underneath, for the folder rows' ± labels. */
  adds: number
  dels: number
  fileCount: number
}

function newDir(name: string, path: string): TreeDir {
  return { kind: 'dir', name, path, dirs: [], files: [], adds: 0, dels: 0, fileCount: 0 }
}

/** Compact `a/(only b)/(only c)` into one `a/b/c` row — never the root. */
function compact(dir: TreeDir): TreeDir {
  let current = dir
  while (current.files.length === 0 && current.dirs.length === 1) {
    const only = current.dirs[0] as TreeDir
    current = { ...only, name: `${current.name}/${only.name}` }
  }
  return { ...current, dirs: current.dirs.map(compact) }
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

/** Changed files (the `/changes` payload order) → the sorted, compacted tree root. */
export function buildFileTree(files: ChangedFile[]): TreeDir {
  const root = newDir('', '')
  const dirsByPath = new Map<string, TreeDir>([['', root]])

  const dirFor = (path: string): TreeDir => {
    const existing = dirsByPath.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const parent = dirFor(slash === -1 ? '' : path.slice(0, slash))
    const dir = newDir(slash === -1 ? path : path.slice(slash + 1), path)
    parent.dirs.push(dir)
    dirsByPath.set(path, dir)
    return dir
  }

  for (const file of files) {
    const slash = file.path.lastIndexOf('/')
    const dir = dirFor(slash === -1 ? '' : file.path.slice(0, slash))
    dir.files.push({
      kind: 'file',
      name: slash === -1 ? file.path : file.path.slice(slash + 1),
      path: file.path,
      status: file.status,
      adds: file.adds,
      dels: file.dels,
      binary: file.binary,
    })
  }

  // Aggregate bottom-up, then sort + compact. Recursion depth is path depth — fine.
  const aggregate = (dir: TreeDir): void => {
    dir.dirs.forEach(aggregate)
    dir.adds = dir.files.reduce((s, f) => s + f.adds, 0) + dir.dirs.reduce((s, d) => s + d.adds, 0)
    dir.dels = dir.files.reduce((s, f) => s + f.dels, 0) + dir.dirs.reduce((s, d) => s + d.dels, 0)
    dir.fileCount = dir.files.length + dir.dirs.reduce((s, d) => s + d.fileCount, 0)
    dir.dirs.sort(byName)
    dir.files.sort(byName)
  }
  aggregate(root)

  return { ...root, dirs: root.dirs.map(compact) }
}
