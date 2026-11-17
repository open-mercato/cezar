// `./source` is workspace-only: the tarball has no src/. prepack strips it, postpack restores
// the byte-exact manifest (a failed pack leaves the backup, and the next pack keeps it).
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const manifest = new URL('../package.json', import.meta.url)
const backup = new URL('../.package.json.prepack', import.meta.url)
if (process.argv[2] === 'restore') {
  if (existsSync(backup)) renameSync(backup, manifest)
} else {
  if (!existsSync(backup)) copyFileSync(manifest, backup)
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  delete pkg.exports['./source']
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`)
}
