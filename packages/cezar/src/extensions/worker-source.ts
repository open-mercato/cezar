// The extension worker's runnable source. The worker is a real typed module (extension-worker.ts):
// the built package runs tsc's sibling `.js`; a source checkout (tests, `npm run dev`) strips the
// types with esbuild, a devDependency, so no build step is needed to work on it.
import { readFile } from 'node:fs/promises'

let cached: Promise<string> | undefined

export function workerSource(): Promise<string> {
  cached ??= load().catch(error => {
    cached = undefined
    throw error
  })
  return cached
}

async function load(): Promise<string> {
  const fromSource = import.meta.url.endsWith('.ts')
  const file = new URL(fromSource ? './extension-worker.ts' : './extension-worker.js', import.meta.url)
  const code = await readFile(file, 'utf8')
  if (!fromSource) return `${code}\nstartExtensionWorker();\n`
  const { transform } = await import('esbuild')
  return `${(await transform(code, { loader: 'ts', format: 'esm', target: 'node20' })).code}\nstartExtensionWorker();\n`
}
