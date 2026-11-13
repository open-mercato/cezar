// The published entry is self-contained; the host ships these exact bytes.
import { build } from 'esbuild'
await build({entryPoints:['src/index.ts'],outfile:'dist/index.js',bundle:true,platform:'node',format:'esm',target:'node20',
  banner:{js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"},
  external:['bufferutil','utf-8-validate'],logLevel:'warning'})
