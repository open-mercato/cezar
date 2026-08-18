export interface CezarStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

function storageKey(identity: string, projectId: string | null, key: string): string {
  return `cezar:${identity}:${projectId ?? 'boot'}:${key}`
}

function localStorageWhenAvailable(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

/** Browser persistence resolved only when an operation is performed. */
export function createCezarBrowserStorage(
  identity: string,
  projectId: string | null,
): CezarStorage {
  return {
    getItem: (key) => localStorageWhenAvailable()?.getItem(storageKey(identity, projectId, key)) ?? null,
    setItem: (key, value) => {
      localStorageWhenAvailable()?.setItem(storageKey(identity, projectId, key), value)
    },
    removeItem: (key) => {
      localStorageWhenAvailable()?.removeItem(storageKey(identity, projectId, key))
    },
  }
}

/** Instance-local storage for tests and hosts that deliberately avoid persistence. */
export function createCezarMemoryStorage(
  initial: Readonly<Record<string, string>> = {},
): CezarStorage {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}
