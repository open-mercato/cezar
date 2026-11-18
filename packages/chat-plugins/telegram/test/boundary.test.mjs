import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { parseSync } from 'oxc-parser'
import test from 'node:test'

function imports(source, filename) {
  const result = []
  const tree = parseSync(filename, source)
  assert.equal(tree.errors.length, 0, filename)
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression','TSImportType'].includes(node.type) && typeof node.source?.value === 'string') result.push(node.source.value)
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require' && typeof node.arguments[0]?.value === 'string') result.push(node.arguments[0].value)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(tree.program)
  return result
}
function assertPublicImports(source, filename) {
  for (const specifier of imports(source,filename)) {
    assert.doesNotMatch(specifier, /@open-mercato\/cezar(?:-contract|-api-client)?(?:$|['"/])/, filename)
    assert.doesNotMatch(specifier, /packages\/cezar|\.\.\/\.\.\//, filename)
  }
}
test('boundary checker distinguishes bundle labels from private imports and declarations',()=>{
 assertPublicImports('// ../../../node_modules/public-sdk/index.ts\nconst label="../../source";', 'bundle.js')
 for(const source of ['import x from "@open-mercato/cezar"','export {x} from "../../private.js"','type X = import("@open-mercato/cezar-contract").X','const x=import("../../../private.js")','const x=require("@open-mercato/cezar/private")']) assert.throws(()=>assertPublicImports(source,'fixture.ts'))
})

test('published sources and declarations depend only on the public SDK', async () => {
  const root = new URL('..', import.meta.url)
  const files = [
    ...(await readdir(new URL('src/', root))).map(name => new URL(`src/${name}`, root)),
    ...(await readdir(new URL('dist/', root))).filter(name => name.endsWith('.d.ts') || name.endsWith('.js')).map(name => new URL(`dist/${name}`, root)),
  ]
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    assertPublicImports(source, file.pathname)
  }
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies), ['@open-mercato/cezar-extension-sdk', 'undici'])
  assert.doesNotMatch(JSON.stringify(pkg), /workspace:|file:/)
})
