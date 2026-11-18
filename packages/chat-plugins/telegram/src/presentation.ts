/** Explicit host rendering only: balanced b/code/a tags and ordinary escaped text.
 * Plain ChatMessage.text never enters this parser or enables Telegram HTML. */
export function validTelegramHtml(text: string): boolean {
 const stack: string[] = []
 for (let at = 0; at < text.length;) {
  const remaining = text.slice(at)
  if (text[at] === '&') {
   const entity = /^&(amp|lt|gt|quot);/.exec(remaining)
   if (!entity) return false
   at += entity[0].length; continue
  }
  if (text[at] === '>') return false
  if (text[at] !== '<') { at++; continue }
  const closing = /^<\/(b|code|a)>/.exec(remaining)
  if (closing) {
   if (stack.pop() !== closing[1]) return false
   at += closing[0].length; continue
  }
  const tag = /^<(b|code)>/.exec(remaining)
  if (tag) { stack.push(tag[1]!); at += tag[0].length; continue }
  const link = /^<a href="([^"<>]*)">/.exec(remaining)
  if (!link) return false
  try {
   const href = link[1]!.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
   const url = new URL(href)
   if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  } catch { return false }
  stack.push('a'); at += link[0].length
 }
 return stack.length === 0
}
