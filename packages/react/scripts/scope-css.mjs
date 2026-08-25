import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import valueParser from 'postcss-value-parser'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCUMENT_TAGS = new Set(['html', 'body'])
const VENDOR_CUSTOM_PROPERTY_PREFIXES = ['--radix-']

function isInsideKeyframes(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name.toLowerCase().endsWith('keyframes')) return true
  }
  return false
}

function prefixIdentifier(identifier) {
  return identifier.startsWith('cezar-') ? identifier : `cezar-${identifier}`
}

const GENERIC_FONT_FAMILIES = new Set([
  'cursive',
  'emoji',
  'fangsong',
  'fantasy',
  'math',
  'monospace',
  'sans-serif',
  'serif',
  'system-ui',
  'ui-monospace',
  'ui-rounded',
  'ui-sans-serif',
  'ui-serif',
])
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'revert', 'revert-layer', 'unset'])
const FONT_SIZE_KEYWORDS = new Set([
  'large',
  'larger',
  'medium',
  'small',
  'smaller',
  'x-large',
  'x-small',
  'xx-large',
  'xx-small',
  'xxx-large',
])

function firstIdentifier(value) {
  return valueParser(value).nodes.find((node) => node.type === 'word' || node.type === 'string')
}

function namespaceCustomProperty(identifier) {
  if (VENDOR_CUSTOM_PROPERTY_PREFIXES.some((prefix) => identifier.startsWith(prefix))) return identifier
  if (identifier.startsWith('--cezar-')) return identifier
  if (identifier.startsWith('--tw-')) return `--cezar-tw-${identifier.slice('--tw-'.length)}`
  return `--cezar-tw-${identifier.slice(2)}`
}

function renameCustomPropertyReferences(value) {
  const parsed = valueParser(value)
  parsed.walk((node) => {
    if (node.type === 'word' && node.value.startsWith('--')) {
      node.value = namespaceCustomProperty(node.value)
    }
  })
  return parsed.toString()
}

function firstSignificantNode(nodes) {
  return nodes.find((node) => node.type !== 'space' && node.type !== 'comment')
}

function namespaceFontFamilyGroup(nodes) {
  const first = firstSignificantNode(nodes)
  if (!first || first.type === 'function') return
  if (first.type === 'string') {
    first.value = prefixIdentifier(first.value)
    return
  }
  if (first.type !== 'word') return

  const significant = nodes.filter((node) => node.type !== 'space' && node.type !== 'comment')
  const isSingleKeyword = significant.length === 1
    && (GENERIC_FONT_FAMILIES.has(first.value.toLowerCase()) || CSS_WIDE_KEYWORDS.has(first.value.toLowerCase()))
  if (!isSingleKeyword) first.value = prefixIdentifier(first.value)
}

function namespaceFontGroups(nodes) {
  let group = []
  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') {
      namespaceFontFamilyGroup(group)
      group = []
    } else {
      group.push(node)
    }
  }
  namespaceFontFamilyGroup(group)
}

function namespaceFontFamilyValue(value) {
  const parsed = valueParser(value)
  namespaceFontGroups(parsed.nodes)
  return parsed.toString()
}

function isFontSizeNode(node) {
  if (node.type === 'function') return true
  if (node.type !== 'word') return false
  const word = node.value.toLowerCase()
  if (FONT_SIZE_KEYWORDS.has(word)) return true
  if (word === '0') return true
  return /^-?(?:\d*\.)?\d+(?:[a-z]+|%)$/i.test(word)
}

function namespaceFontShorthand(value) {
  const parsed = valueParser(value)
  const significantIndexes = parsed.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type !== 'space' && node.type !== 'comment')
  const sizePosition = significantIndexes.findIndex(({ node }) => isFontSizeNode(node))
  if (sizePosition < 0) return parsed.toString()

  let familyPosition = sizePosition + 1
  if (significantIndexes[familyPosition]?.node.type === 'div' && significantIndexes[familyPosition].node.value === '/') {
    familyPosition += 2
  }
  const familyStart = significantIndexes[familyPosition]?.index
  if (familyStart !== undefined) namespaceFontGroups(parsed.nodes.slice(familyStart))
  return parsed.toString()
}

function replaceTopLevelIdentifiers(value, names) {
  if (names.size === 0) return value
  const parsed = valueParser(value)

  for (const node of parsed.nodes) {
    if ((node.type === 'word' || node.type === 'string') && names.has(node.value)) {
      node.value = names.get(node.value)
    }
  }
  return parsed.toString()
}

function collectGlobalNames(root) {
  const keyframes = new Map()

  root.walkAtRules((atRule) => {
    if (!atRule.name.toLowerCase().endsWith('keyframes')) return
    const name = firstIdentifier(atRule.params)
    if (name) keyframes.set(name.value, prefixIdentifier(name.value))
  })

  return keyframes
}

function isAnimationCustomProperty(property) {
  return /^--(?:(?:cezar-)?tw-)?animate(?:-|$)/.test(property)
}

function renameGlobalNames(root, keyframes) {
  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase().endsWith('keyframes')) {
      const parsed = valueParser(atRule.params)
      const name = parsed.nodes.find((node) => node.type === 'word' || node.type === 'string')
      if (name && keyframes.has(name.value)) name.value = keyframes.get(name.value)
      atRule.params = parsed.toString()
    } else {
      atRule.params = renameCustomPropertyReferences(atRule.params)
    }
  })

  root.walkDecls((declaration) => {
    const originalProperty = declaration.prop
    if (declaration.prop.startsWith('--')) declaration.prop = namespaceCustomProperty(declaration.prop)
    declaration.value = renameCustomPropertyReferences(declaration.value)

    const property = originalProperty.toLowerCase()
    if (property === 'animation' || property === 'animation-name' || isAnimationCustomProperty(property)) {
      declaration.value = replaceTopLevelIdentifiers(declaration.value, keyframes)
    }
    if (property === 'font-family') declaration.value = namespaceFontFamilyValue(declaration.value)
    if (property === 'font') declaration.value = namespaceFontShorthand(declaration.value)
  })
}

function selectorHasSafeRoot(selector) {
  let hasAncestorRoot = false
  let currentCompoundHasRoot = false

  selector.each((node) => {
    if (node.type === 'combinator') {
      const combinator = node.value.trim()
      if (combinator === '' || combinator === '>') {
        hasAncestorRoot ||= currentCompoundHasRoot
      }
      currentCompoundHasRoot = false
      return
    }
    if (node.type === 'class' && node.value === 'cezar-root') {
      currentCompoundHasRoot = true
      return
    }
    if (
      node.type === 'pseudo'
      && [':is', ':where'].includes(node.value.toLowerCase())
      && node.nodes?.length
      && node.nodes.every((nestedSelector) => selectorHasSafeRoot(nestedSelector))
    ) {
      currentCompoundHasRoot = true
    }
  })

  return hasAncestorRoot || currentCompoundHasRoot
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
  const keyframes = collectGlobalNames(root)
  renameGlobalNames(root, keyframes)
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
