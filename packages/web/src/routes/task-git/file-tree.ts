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

export interface TreeDir extends PathTreeDir<TreeFile> {
  dirs: TreeDir[]
  /** Aggregates over every file underneath, for the folder rows' ± labels. */
  adds: number
  dels: number
  fileCount: number
}

/**
 * The generic half, shared with the repo Files sub-tab (#1279): paths → nested, sorted, compacted
 * folders, with the LEAF shape left to the caller. The Changes tree layers ± aggregates on top;
 * the repository browser needs the same nesting and compaction with no counts at all, and
 * duplicating this is how the two trees would drift.
 */
export interface PathTreeDir<F extends { name: string }> {
  kind: 'dir'
  /** Display name; compacted chains keep their joined path ("packages/web/src"). */
  name: string
  /** Full path from the root ('' for the root itself). */
  path: string
  dirs: PathTreeDir<F>[]
  files: F[]
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)

/** Compact `a/(only b)/(only c)` into one `a/b/c` row — never the root. */
function compact<F extends { name: string }>(dir: PathTreeDir<F>): PathTreeDir<F> {
  let current = dir
  while (current.files.length === 0 && current.dirs.length === 1) {
    const only = current.dirs[0] as PathTreeDir<F>
    current = { ...only, name: `${current.name}/${only.name}` }
  }
  return { ...current, dirs: current.dirs.map(compact) }
}

/**
 * Plain repo-relative paths → the sorted, compacted tree root, with `leaf` building each file node.
 *
 * Sorting happens BEFORE compaction, deliberately: the row's display name is the joined chain, and
 * ordering siblings by their joined names would reshuffle a folder list whenever a chain grew a
 * segment. (This is also exactly what the Changes tree has always done.)
 */
export function buildPathTree<F extends { name: string }>(
  paths: readonly string[],
  leaf: (path: string, name: string) => F,
): PathTreeDir<F> {
  const newDir = (name: string, path: string): PathTreeDir<F> => ({
    kind: 'dir',
    name,
    path,
    dirs: [],
    files: [],
  })
  const root = newDir('', '')
  const dirsByPath = new Map<string, PathTreeDir<F>>([['', root]])

  const dirFor = (path: string): PathTreeDir<F> => {
    const existing = dirsByPath.get(path)
    if (existing) return existing
    const slash = path.lastIndexOf('/')
    const parent = dirFor(slash === -1 ? '' : path.slice(0, slash))
    const dir = newDir(slash === -1 ? path : path.slice(slash + 1), path)
    parent.dirs.push(dir)
    dirsByPath.set(path, dir)
    return dir
  }

  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const dir = dirFor(slash === -1 ? '' : path.slice(0, slash))
    dir.files.push(leaf(path, slash === -1 ? path : path.slice(slash + 1)))
  }

  // Recursion depth is path depth — fine.
  const sort = (dir: PathTreeDir<F>): void => {
    dir.dirs.forEach(sort)
    dir.dirs.sort(byName)
    dir.files.sort(byName)
  }
  sort(root)

  return { ...root, dirs: root.dirs.map(compact) }
}

/**
 * Untracked junk (redesign 2026-11, "Changes trees"): OS cruft, image/GIF frames, media, archives,
 * fonts and compiled binaries. They are listed — the counts stay honest — but a tree de-emphasises
 * them under the source files, folded when there are many, so a drop of screenshots never buries
 * the eight-line fix beside it. Name-based on purpose: the Files tab's directory listing carries no
 * `binary` flag, and the two trees must agree on what junk is. `svg` is NOT junk — it is authored.
 */
const JUNK_NAMES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini', '.localized'])
const JUNK_EXTENSIONS: ReadonlySet<string> = new Set([
  // images (svg excluded) and media
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic', 'psd',
  'mp4', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'ogg', 'flac',
  // documents and archives
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso',
  // fonts and compiled output
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm', 'exe', 'dll', 'dylib', 'so', 'o', 'a', 'class', 'jar', 'pyc', 'node',
])

export function isJunkPath(path: string, binary = false): boolean {
  if (binary) return true
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (JUNK_NAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return JUNK_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** Source first, junk after — one rule for every tree, so the two tabs cannot order differently. */
export function partitionJunk<F>(files: readonly F[], isJunk: (file: F) => boolean): { source: F[]; junk: F[] } {
  const source: F[] = []
  const junk: F[] = []
  for (const file of files) (isJunk(file) ? junk : source).push(file)
  return { source, junk }
}

/** Past this many junk rows in one folder they fold under a single row, closed by default. */
export const JUNK_FOLD_AT = 3

/** Changed files (the `/changes` payload order) → the sorted, compacted tree root with ± counts. */
export function buildFileTree(files: ChangedFile[]): TreeDir {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const generic = buildPathTree(
    files.map((file) => file.path),
    (path, name): TreeFile => {
      const file = byPath.get(path) as ChangedFile
      return {
        kind: 'file',
        name,
        path,
        status: file.status,
        adds: file.adds,
        dels: file.dels,
        binary: file.binary,
      }
    },
  )

  // Aggregate bottom-up over the already-sorted, already-compacted tree. Compaction only renames
  // a chain's row, so the sums are the same whichever side of it they are computed on.
  const aggregate = (dir: PathTreeDir<TreeFile>): TreeDir => {
    const dirs = dir.dirs.map(aggregate)
    return {
      ...dir,
      dirs,
      adds: dir.files.reduce((s, f) => s + f.adds, 0) + dirs.reduce((s, d) => s + d.adds, 0),
      dels: dir.files.reduce((s, f) => s + f.dels, 0) + dirs.reduce((s, d) => s + d.dels, 0),
      fileCount: dir.files.length + dirs.reduce((s, d) => s + d.fileCount, 0),
    }
  }
  return aggregate(generic)
}
