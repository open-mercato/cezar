import { init, parse } from 'es-module-lexer'

export const violatesBoundary = (specifier) =>
  /(?:^|\/)packages\/web(?:\/|$)/.test(specifier)
  || specifier === '@'
  || specifier.startsWith('@/')
  || specifier === '@open-mercato/cezar-contract'
  || specifier.startsWith('@open-mercato/cezar-contract/')
  || specifier === '@open-mercato/cezar-react/src'
  || specifier.startsWith('@open-mercato/cezar-react/src/')
  || specifier.startsWith('node:')

export const findProhibitedSpecifiers = async (source) => {
  await init
  const [imports] = parse(source)

  return imports.flatMap(({ n: specifier }) =>
    typeof specifier === 'string' && violatesBoundary(specifier) ? [specifier] : [],
  )
}
