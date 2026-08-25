import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import selectorParser from 'postcss-selector-parser'
import valueParser from 'postcss-value-parser'

const DOCUMENT_TAGS = new Set(['html', 'body'])
const VENDOR_CUSTOM_PROPERTY_PREFIXES = ['--radix-']
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
const ANIMATION_KEYWORDS = new Set([
  ...CSS_WIDE_KEYWORDS,
  'alternate',
  'alternate-reverse',
  'backwards',
  'both',
  'ease',
  'ease-in',
  'ease-in-out',
  'ease-out',
  'forwards',
  'infinite',
  'linear',
  'none',
  'normal',
  'paused',
  'reverse',
  'running',
  'step-end',
  'step-start',
])
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

function isInsideKeyframes(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name.toLowerCase().endsWith('keyframes')) return true
  }
  return false
}

function selectorHasScopedRoot(selector) {
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
      && node.nodes.every((nestedSelector) => selectorHasScopedRoot(nestedSelector))
    ) {
      currentCompoundHasRoot = true
    }
  })

  return hasAncestorRoot || currentCompoundHasRoot
}

function verifySelectors(root) {
  root.walkRules((rule) => {
    if (isInsideKeyframes(rule)) return

    selectorParser((selectors) => {
      selectors.each((selector) => {
        let documentSelector = false
        selector.walk((node) => {
          if (node.type === 'tag' && DOCUMENT_TAGS.has(node.value.toLowerCase())) {
            documentSelector = true
          }
          if (node.type === 'pseudo' && node.value.toLowerCase() === ':root') {
            documentSelector = true
          }
        })

        if (documentSelector) throw new Error(`document selector: ${selector}`)
        if (!selectorHasScopedRoot(selector) && selector.some((node) => node.type === 'universal')) {
          throw new Error(`unscoped universal selector: ${selector}`)
        }
        if (!selectorHasScopedRoot(selector)) {
          throw new Error(`selector outside .cezar-root: ${selector}`)
        }
      })
    }).processSync(rule.selector)
  })
}

function firstSignificantNode(nodes) {
  return nodes.find((node) => node.type !== 'space' && node.type !== 'comment')
}

function assertNamespacedFontGroups(nodes) {
  let group = []

  const verifyGroup = () => {
    const first = firstSignificantNode(group)
    const significant = group.filter((node) => node.type !== 'space' && node.type !== 'comment')
    group = []
    if (!first || first.type === 'function') return
    if (first.type === 'string') {
      if (!first.value.startsWith('cezar-')) throw new Error(`unnamespaced font family: ${first.value}`)
      return
    }
    if (first.type !== 'word') return
    const name = first.value.toLowerCase()
    const isSingleKeyword = significant.length === 1
      && (GENERIC_FONT_FAMILIES.has(name) || CSS_WIDE_KEYWORDS.has(name))
    if (!isSingleKeyword && !name.startsWith('cezar-')) {
      throw new Error(`unnamespaced font family: ${first.value}`)
    }
  }

  for (const node of nodes) {
    if (node.type === 'div' && node.value === ',') verifyGroup()
    else group.push(node)
  }
  verifyGroup()
}

function assertNamespacedFontFamily(value) {
  const parsed = valueParser(value)
  assertNamespacedFontGroups(parsed.nodes)
}

function isFontSizeNode(node) {
  if (node.type === 'function') return true
  if (node.type !== 'word') return false
  const word = node.value.toLowerCase()
  if (FONT_SIZE_KEYWORDS.has(word)) return true
  if (word === '0') return true
  return /^-?(?:\d*\.)?\d+(?:[a-z]+|%)$/i.test(word)
}

function assertNamespacedFontShorthand(value) {
  const parsed = valueParser(value)
  const significantIndexes = parsed.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.type !== 'space' && node.type !== 'comment')
  const sizePosition = significantIndexes.findIndex(({ node }) => isFontSizeNode(node))
  if (sizePosition < 0) return

  let familyPosition = sizePosition + 1
  if (significantIndexes[familyPosition]?.node.type === 'div' && significantIndexes[familyPosition].node.value === '/') {
    familyPosition += 2
  }
  const familyStart = significantIndexes[familyPosition]?.index
  if (familyStart !== undefined) assertNamespacedFontGroups(parsed.nodes.slice(familyStart))
}

function isAnimationNonName(word) {
  const normalized = word.toLowerCase()
  return ANIMATION_KEYWORDS.has(normalized)
    || /^-?(?:\d*\.)?\d+(?:ms|s)?$/.test(normalized)
}

function assertNamespacedAnimation(value) {
  const parsed = valueParser(value)
  for (const node of parsed.nodes) {
    if (node.type === 'function' || node.type === 'space' || node.type === 'comment' || node.type === 'div') continue
    if ((node.type === 'word' || node.type === 'string') && !isAnimationNonName(node.value) && !node.value.startsWith('cezar-')) {
      throw new Error(`unnamespaced keyframe reference: ${node.value}`)
    }
  }
}

function isAnimationCustomProperty(property) {
  return /^--cezar-tw-animate(?:-|$)/.test(property)
}

function assertNamespacedCustomPropertyReference(identifier) {
  if (identifier.startsWith('--tw-')) throw new Error(`raw --tw-* identifier: ${identifier}`)
  if (VENDOR_CUSTOM_PROPERTY_PREFIXES.some((prefix) => identifier.startsWith(prefix))) return
  if (!identifier.startsWith('--cezar-')) {
    throw new Error(`non-Cezar custom property reference: ${identifier}`)
  }
}

function verifyIdentifiers(root) {
  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--tw-')) {
      throw new Error(`raw --tw-* identifier: ${declaration.prop}`)
    }
    if (
      declaration.prop.startsWith('--')
      && !declaration.prop.startsWith('--cezar-')
      && !VENDOR_CUSTOM_PROPERTY_PREFIXES.some((prefix) => declaration.prop.startsWith(prefix))
    ) {
      throw new Error(`non-Cezar custom property declaration: ${declaration.prop}`)
    }

    valueParser(declaration.value).walk((node) => {
      if (node.type === 'word' && node.value.startsWith('--')) assertNamespacedCustomPropertyReference(node.value)
    })

    const property = declaration.prop.toLowerCase()
    if (property === 'font-family') assertNamespacedFontFamily(declaration.value)
    if (property === 'font') assertNamespacedFontShorthand(declaration.value)
    if (property === 'animation' || property === 'animation-name' || isAnimationCustomProperty(property)) {
      assertNamespacedAnimation(declaration.value)
    }
  })

  root.walkAtRules((atRule) => {
    const atRuleName = atRule.name.toLowerCase()
    if (atRuleName.endsWith('keyframes')) {
      const name = valueParser(atRule.params).nodes.find((node) => node.type === 'word' || node.type === 'string')
      if (!name?.value.startsWith('cezar-')) {
        throw new Error(`unnamespaced keyframe: ${name?.value ?? atRule.params}`)
      }
    }

    if (atRuleName === 'property') {
      const property = valueParser(atRule.params).nodes.find((node) => node.type === 'word')
      if (!property?.value.startsWith('--cezar-')) {
        throw new Error(`non-Cezar @property: ${property?.value ?? atRule.params}`)
      }
    }

    valueParser(atRule.params).walk((node) => {
      if (node.type === 'word' && node.value.startsWith('--')) assertNamespacedCustomPropertyReference(node.value)
    })
  })
}

export async function verifyCss(css) {
  const root = postcss.parse(css)
  verifySelectors(root)
  verifyIdentifiers(root)
}

async function main() {
  const file = process.argv[2]
  if (!file) throw new Error('usage: node scripts/verify-css.mjs <css-file>')
  await verifyCss(await readFile(file, 'utf8'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
