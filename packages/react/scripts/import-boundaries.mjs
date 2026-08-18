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
  const specifiers = []

  for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token === SyntaxKind.ImportKeyword) {
      token = scanner.scan()
      if (token === SyntaxKind.StringLiteral) {
        specifiers.push(scanner.getTokenValue())
        continue
      }
      if (token === SyntaxKind.OpenParenToken) {
        token = scanner.scan()
        if (token === SyntaxKind.StringLiteral) {
          specifiers.push(scanner.getTokenValue())
        }
        continue
      }
      while (token !== SyntaxKind.EndOfFile && token !== SyntaxKind.SemicolonToken) {
        if (token === SyntaxKind.FromKeyword) {
          token = scanner.scan()
          if (token === SyntaxKind.StringLiteral) {
            specifiers.push(scanner.getTokenValue())
          }
          break
        }
        token = scanner.scan()
      }
      continue
    }

    if (token === SyntaxKind.ExportKeyword) {
      while (token !== SyntaxKind.EndOfFile && token !== SyntaxKind.SemicolonToken) {
        if (token === SyntaxKind.FromKeyword) {
          token = scanner.scan()
          if (token === SyntaxKind.StringLiteral) {
            specifiers.push(scanner.getTokenValue())
          }
          break
        }
        token = scanner.scan()
      }
    }
  }

  return specifiers.filter(violatesBoundary)
}
