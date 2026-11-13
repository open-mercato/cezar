export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_PENDING_CALLS = 100
export function encodeFrame(value: unknown): string {
  const frame = JSON.stringify(value)
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error('extension IPC frame exceeds 1 MiB')
  return `${frame}\n`
}
