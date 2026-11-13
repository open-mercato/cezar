/// <reference types="vitest/jsdom" />

// Radix popper content (tooltips, popovers) measures its anchor with ResizeObserver, which jsdom
// lacks. A no-op stub lets a focused IconTooltip trigger open without throwing.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: ResizeObserverStub })
}

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
