import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from 'typescript/unstable/ast'

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
  const scanner = createScanner(true, LanguageVariant.JSX, source)
  const tokens = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({ kind, value: scanner.getTokenValue() })
  }
  const specifiers = []

  const followsPropertyAccess = (index) =>
    tokens[index - 1]?.kind === SyntaxKind.DotToken
    || tokens[index - 1]?.kind === SyntaxKind.QuestionDotToken

  const sourceAfterFrom = (start) => {
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (
        token.kind === SyntaxKind.SemicolonToken
        || token.kind === SyntaxKind.ImportKeyword
        || token.kind === SyntaxKind.ExportKeyword
      ) {
        return undefined
      }
      if (token.kind === SyntaxKind.FromKeyword) {
        const sourceToken = tokens[index + 1]
        return sourceToken?.kind === SyntaxKind.StringLiteral ? sourceToken.value : undefined
      }
    }
    return undefined
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.kind === SyntaxKind.ImportKeyword && !followsPropertyAccess(index)) {
      const next = tokens[index + 1]
      if (next?.kind === SyntaxKind.StringLiteral) {
        specifiers.push(next.value)
        continue
      }
      if (next?.kind === SyntaxKind.OpenParenToken) {
        const sourceToken = tokens[index + 2]
        if (sourceToken?.kind === SyntaxKind.StringLiteral) {
          specifiers.push(sourceToken.value)
        }
        continue
      }
      if (
        next?.kind === SyntaxKind.Identifier
        || next?.kind === SyntaxKind.TypeKeyword
        || next?.kind === SyntaxKind.AsteriskToken
        || next?.kind === SyntaxKind.OpenBraceToken
      ) {
        const specifier = sourceAfterFrom(index + 2)
        if (specifier !== undefined) specifiers.push(specifier)
      }
      continue
    }

    if (token.kind === SyntaxKind.ExportKeyword && !followsPropertyAccess(index)) {
      const next = tokens[index + 1]
      const isReexport = next?.kind === SyntaxKind.AsteriskToken
        || next?.kind === SyntaxKind.OpenBraceToken
        || (
          next?.kind === SyntaxKind.TypeKeyword
          && (
            tokens[index + 2]?.kind === SyntaxKind.AsteriskToken
            || tokens[index + 2]?.kind === SyntaxKind.OpenBraceToken
          )
        )
      if (isReexport) {
        const specifier = sourceAfterFrom(index + 2)
        if (specifier !== undefined) specifiers.push(specifier)
      }
    }
  }

  return specifiers.filter(violatesBoundary)
}
