import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// index.html's boot guard: a shell naming /assets/* files the server no longer has must not stay black.
const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8')
const guard = /<script id="cez-boot-guard">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  } as Storage
}

const installed: ((e: Event) => void)[] = []

/** Runs the guard against fakes for what it must not really do (reload) or share between cases. */
function boot({ storage = memoryStorage(), userAgent = 'Mozilla/5.0' } = {}) {
  const reload = vi.fn()
  const add = window.addEventListener.bind(window)
  const spy = vi.spyOn(window, 'addEventListener').mockImplementation((type, fn, options) => {
    if (type === 'error') installed.push(fn as (e: Event) => void)
    add(type, fn, options)
  })
  new Function('location', 'sessionStorage', 'navigator', guard)({ reload }, storage, { userAgent })
  spy.mockRestore()
  return { reload, storage }
}

function failLoad(tag: 'script' | 'link', url: string, rel = 'stylesheet') {
  const el = document.createElement(tag)
  if (el instanceof HTMLScriptElement) el.src = url
  if (el instanceof HTMLLinkElement) {
    el.rel = rel
    el.href = url
  }
  document.head.appendChild(el)
  el.dispatchEvent(new Event('error'))
  el.remove()
}

afterEach(() => {
  for (const fn of installed.splice(0)) window.removeEventListener('error', fn, true)
  delete window.__cezBootFallback
  delete window.__cezBootDone
  document.body.innerHTML = ''
})

describe('index.html boot guard', () => {
  it('is in the shell', () => {
    expect(guard).toContain('cez-boot-reload-at')
  })

  it('reloads once when the entry script is gone', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const { reload } = boot()
    failLoad('script', 'http://127.0.0.1:4000/assets/index-old.js')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(document.getElementById('root')?.childElementCount).toBe(0)
  })

  it('shows a way out instead of a black page when the reload hit the same failure', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const storage = memoryStorage()
    storage.setItem('cez-boot-reload-at', String(Date.now() - 1000))
    const { reload } = boot({ storage })
    failLoad('link', '/assets/index-old.css')
    expect(reload).not.toHaveBeenCalled()
    const root = document.getElementById('root')!
    expect(root.textContent).toContain('cezar could not start')
    expect(root.querySelector('a[href="cezar://servers"]')).toBeNull()
    ;(root.querySelector('#cez-boot-reload') as HTMLButtonElement).click()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('offers Your cezars in the phone app', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const storage = memoryStorage()
    storage.setItem('cez-boot-reload-at', String(Date.now()))
    boot({ storage, userAgent: 'Mozilla/5.0 Mobile/15E148 CezarMobile/0.1.1 (ios)' })
    failLoad('script', '/assets/index-old.js')
    expect(document.querySelector('a[href="cezar://servers"]')?.textContent).toBe('Your cezars')
  })

  it('reloads again after the guard window, so a later update recovers too', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const storage = memoryStorage()
    storage.setItem('cez-boot-reload-at', String(Date.now() - 61_000))
    const { reload } = boot({ storage })
    failLoad('script', '/assets/index-old.js')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores files that are not the bundle, and everything once the entry has run', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const { reload } = boot()
    failLoad('link', '/icon.svg', 'icon')
    failLoad('script', 'https://cdn.example.com/x.js')
    expect(reload).not.toHaveBeenCalled()
    window.__cezBootDone?.()
    failLoad('link', '/assets/route-old.js', 'modulepreload')
    expect(reload).not.toHaveBeenCalled()
  })

  it('gives main.tsx the same fallback for a crash that unmounts the app', () => {
    document.body.innerHTML = '<div id="root"></div>'
    boot()
    window.__cezBootFallback?.()
    expect(document.getElementById('root')?.textContent).toContain('cezar could not start')
  })
})
