/// <reference types="vitest/jsdom" />

// Node 25 exposes its own Web Storage globals. Browser tests must use the JSDOM
// origin's storage, including its normal clear/key/quota behavior, on every Node version.
const storageWindow = jsdom.window
for (const key of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: storageWindow[key],
  })
}
