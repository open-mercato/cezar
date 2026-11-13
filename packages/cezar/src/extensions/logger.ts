/** `context.logger` lands in the server log, already redacted, capped per extension so a
 *  chatty worker cannot flood it. */
export function extensionLogger(projectId: string, write = (level: 'info' | 'error', line: string) => level === 'error' ? console.error(line) : console.info(line), now = Date.now) {
  const windows = new Map<string, { start: number; count: number }>()
  return (level: 'info' | 'error', message: string, extensionId: string) => {
    const window = windows.get(extensionId)
    if (!window || now() - window.start >= 60_000) windows.set(extensionId, { start: now(), count: 1 })
    else if (++window.count > 100) { if (window.count === 101) write('error', `[extension ${extensionId}] log rate limit reached; dropping messages for a minute`); return false }
    write(level, `[extension ${extensionId}] (${projectId}) ${message.slice(0, 2000)}`)
  }
}
