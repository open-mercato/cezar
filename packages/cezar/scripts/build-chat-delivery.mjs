// Stamp the actual independently built package files; no private host transport entry.
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = join(root,'packages/cezar/dist/chat-plugins')
await rm(output,{recursive:true,force:true}); await mkdir(output,{recursive:true})
const catalog = []
for (const provider of ['telegram']) {
 const source = join(root,'packages/chat-plugins',provider), target = join(output,provider)
 await mkdir(target)
 for (const name of ['dist','package.json','cezar-extension.json','README.md']) await cp(join(source,name),join(target,name),{recursive:true})
 const manifest = JSON.parse(await readFile(join(target,'cezar-extension.json'),'utf8'))
 const pkg = JSON.parse(await readFile(join(target,'package.json'),'utf8'))
 if (manifest.version !== pkg.version) throw Error(`Independent adapter version mismatch: ${provider}`)
 const hash = createHash('sha512')
 async function visit(directory) {
  for (const name of (await readdir(directory)).sort()) {
   const file = join(directory,name), stat = await lstat(file)
   if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('Invalid artifact file')
   hash.update(JSON.stringify([relative(target,file),stat.isDirectory() ? 'directory' : 'file',stat.mode & 0o777]))
   if (stat.isDirectory()) await visit(file); else hash.update(await readFile(file))
  }
 }
 await visit(target)
 catalog.push({provider,extensionId:manifest.id,version:manifest.version,integrity:`sha512-${hash.digest('base64')}`})
}
await writeFile(join(output,'catalog.json'),JSON.stringify(catalog,null,2)+'\n')
console.log('Public chat delivery artifacts stamped: '+catalog.map(item=>item.provider+'@'+item.version).join(', '))
