import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import valueParser from 'postcss-value-parser'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCUMENT_TAGS = new Set(['html', 'body'])

function isInsideKeyframes(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name.toLowerCase().endsWith('keyframes')) return true
  }
  return false
}

function prefixIdentifier(identifier) {
  return identifier.startsWith('cezar-') ? identifier : `cezar-${identifier}`
}

function firstIdentifier(value) {
  return valueParser(value).nodes.find((node) => node.type === 'word' || node.type === 'string')
}

function renameCustomProperties(value) {
  const parsed = valueParser(value)
  parsed.walk((node) => {
    if (node.type === 'word' && node.value.startsWith('--tw-')) {
      node.value = `--cezar-tw-${node.value.slice('--tw-'.length)}`
    }
  })
  return parsed.toString()
}

function readFontFamily(value) {
  const parsed = valueParser(value)
  const first = parsed.nodes.find((node) => node.type !== 'space' && node.type !== 'comment')
  if (!first) return undefined
  if (first.type === 'string') return first.value

  const family = []
  for (const node of parsed.nodes) {
    if (node.type === 'div' && node.value === ',') break
    if (node.type === 'word' || node.type === 'string') family.push(node.value)
  }
  return family.join(' ') || undefined
}

function renameDeclaredFontFamily(value, renamed) {
  const parsed = valueParser(value)
  const first = parsed.nodes.find((node) => node.type === 'word' || node.type === 'string')
  if (first) first.value = first.type === 'string' ? renamed : prefixIdentifier(first.value)
  return parsed.toString()
}

function replaceNamedIdentifiers(value, names) {
  if (names.size === 0) return value
  const parsed = valueParser(value)

  parsed.walk((node) => {
    if ((node.type === 'word' || node.type === 'string') && names.has(node.value)) {
      node.value = names.get(node.value)
    }
  })

  for (const [original] of names) {
    const words = original.split(/\s+/)
    if (words.length < 2) continue
    for (let index = 0; index < parsed.nodes.length; index += 1) {
      if (parsed.nodes[index]?.type !== 'word' || parsed.nodes[index].value !== words[0]) continue
      const followingWords = parsed.nodes
        .slice(index + 1)
        .filter((node) => node.type !== 'space')
        .slice(0, words.length - 1)
      if (followingWords.every((node, wordIndex) => node.type === 'word' && node.value === words[wordIndex + 1])) {
        parsed.nodes[index].value = prefixIdentifier(parsed.nodes[index].value)
      }
    }
  }

  return parsed.toString()
}

function collectGlobalNames(root) {
  const keyframes = new Map()
  const fonts = new Map()

  root.walkAtRules((atRule) => {
    if (!atRule.name.toLowerCase().endsWith('keyframes')) return
    const name = firstIdentifier(atRule.params)
    if (name) keyframes.set(name.value, prefixIdentifier(name.value))
  })

  root.walkAtRules('font-face', (fontFace) => {
    fontFace.walkDecls('font-family', (declaration) => {
      const family = readFontFamily(declaration.value)
      if (family) fonts.set(family, prefixIdentifier(family))
    })
  })

  return { keyframes, fonts }
}

function renameGlobalNames(root, keyframes, fonts) {
  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase().endsWith('keyframes')) {
      const parsed = valueParser(atRule.params)
      const name = parsed.nodes.find((node) => node.type === 'word' || node.type === 'string')
      if (name && keyframes.has(name.value)) name.value = keyframes.get(name.value)
      atRule.params = parsed.toString()
    } else {
      atRule.params = renameCustomProperties(atRule.params)
    }
  })

  root.walkAtRules('font-face', (fontFace) => {
    fontFace.walkDecls('font-family', (declaration) => {
      const family = readFontFamily(declaration.value)
      if (family && fonts.has(family)) {
        declaration.value = renameDeclaredFontFamily(declaration.value, fonts.get(family))
      }
    })
  })

  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--tw-')) {
      declaration.prop = `--cezar-tw-${declaration.prop.slice('--tw-'.length)}`
    }
    declaration.value = renameCustomProperties(declaration.value)
    declaration.value = replaceNamedIdentifiers(declaration.value, keyframes)
    declaration.value = replaceNamedIdentifiers(declaration.value, fonts)
  })
}

function selectorHasSafeRoot(selector) {
  let isScoped = false

  selector.each((node) => {
    if (node.type === 'combinator' && ['+', '~', '||'].includes(node.value.trim())) {
      isScoped = false
      return
    }
    if (node.type === 'class' && node.value === 'cezar-root') {
      isScoped = true
      return
    }
    if (
      node.type === 'pseudo'
      && [':is', ':where'].includes(node.value.toLowerCase())
      && node.nodes?.length
      && node.nodes.every((nestedSelector) => selectorHasSafeRoot(nestedSelector))
    ) {
      isScoped = true
    }
  })

  return isScoped
}

function scopeSelectors(root) {
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule)) return

    rule.selector = selectorParser((selectors) => {
      selectors.walk((node) => {
        if (node.type === 'tag' && DOCUMENT_TAGS.has(node.value.toLowerCase())) {
          node.replaceWith(selectorParser.className({ value: 'cezar-root' }))
        } else if (
          node.type === 'pseudo'
          && [':root', ':host'].includes(node.value.toLowerCase())
          && !node.nodes?.length
        ) {
          node.replaceWith(selectorParser.className({ value: 'cezar-root' }))
        }
      })

      selectors.each((selector) => {
        if (selectorHasSafeRoot(selector)) return
        selector.prepend(selectorParser.combinator({ value: ' ' }))
        selector.prepend(selectorParser.className({ value: 'cezar-root' }))
      })
    }).processSync(rule.selector)
  })
}

export async function scopeCss(css) {
  const root = postcss.parse(css)
  const { keyframes, fonts } = collectGlobalNames(root)
  renameGlobalNames(root, keyframes, fonts)
  scopeSelectors(root)
  return root.toString()
}

async function main() {
  const file = process.argv[2] ?? resolve(packageDir, 'dist/styles.css')
  const transformed = await scopeCss(await readFile(file, 'utf8'))
  await writeFile(file, transformed)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
