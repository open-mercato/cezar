// Stamp the actual independently built package files; no private host transport entry.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { cp, mkdir, open, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
 // Hash file bytes through the handle that was stat'ed, never a re-opened path (CodeQL fs race).
 // `/` paths and no mode bits: the installer's umask and platform decide those (shippedArtifactIntegrity).
 const portable = file => relative(target,file).split(sep).join('/')
 async function visit(directory) {
  const entries = (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const entry of entries) {
   const file = join(directory,entry.name)
   if (entry.isDirectory()) {
    const stat = await lstat(file)
    if (!stat.isDirectory()) throw Error('Invalid artifact file')
    hash.update(JSON.stringify([portable(file),'directory']))
    await visit(file)
   } else if (entry.isFile()) {
    const handle = await open(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
     const stat = await handle.stat()
     if (!stat.isFile()) throw Error('Invalid artifact file')
     hash.update(JSON.stringify([portable(file),'file']))
     hash.update(await handle.readFile())
    } finally { await handle.close() }
   } else throw Error('Invalid artifact file')
  }
 }
 await visit(target)
 catalog.push({provider,extensionId:manifest.id,version:manifest.version,integrity:`sha512-${hash.digest('base64')}`})
}
await writeFile(join(output,'catalog.json'),JSON.stringify(catalog,null,2)+'\n')
console.log('Public chat delivery artifacts stamped: '+catalog.map(item=>item.provider+'@'+item.version).join(', '))
