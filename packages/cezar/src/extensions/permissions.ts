import type { ExtensionPermission } from '@open-mercato/cezar-contract'

export class ExtensionPermissionError extends Error {
  constructor(permission: ExtensionPermission) {
    super(`extension permission is not granted: ${permission}`)
    this.name = 'ExtensionPermissionError'
  }
}

export function requireExtensionPermission(granted: readonly string[], permission: ExtensionPermission): void {
  if (!granted.includes(permission)) throw new ExtensionPermissionError(permission)
}
