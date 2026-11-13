import { join } from 'node:path'

/** Where the chat simulator publishes its control port, keyed by the app port the runner chose. */
export const chatControlFile = (appPort: string | undefined): string => join(import.meta.dirname, '.e2e', 'chat-control', `${appPort}.json`)
