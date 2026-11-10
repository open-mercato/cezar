/**
 * One shared IntersectionObserver that marks watched elements `data-offscreen` while they are
 * outside the viewport, so CSS can pause their infinite animations (a long chat holds dozens of
 * pulsing status dots; each one still costs main-thread frames off screen).
 * Without IntersectionObserver (jsdom, old engines) it does nothing.
 */
let observer: IntersectionObserver | null = null
let watched = 0

function sharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting)
  })
  return observer
}

/** Watch `element` until the returned function is called. */
export function watchOffscreen(element: Element): () => void {
  const io = sharedObserver()
  if (!io) return () => {}
  io.observe(element)
  watched += 1
  return () => {
    io.unobserve(element)
    element.removeAttribute('data-offscreen')
    watched -= 1
    if (watched === 0 && observer === io) {
      io.disconnect()
      observer = null
    }
  }
}
