import { createContext, type ReactNode } from 'react'

/** How a card paints the agent's words. A task's card shows them as written; a manager's turns its
 *  PR, issue and task markers into the chat's chips (`manager/manager-reference.tsx`). */
export interface AskTextRenderer {
  render: (text: string) => ReactNode
  /** The same words with no markup, for accessible names. */
  plain: (text: string) => string
  /** Whether `render` paints something the user can click. */
  interactive: (text: string) => boolean
}

const PLAIN_TEXT: AskTextRenderer = { render: (text) => text, plain: (text) => text, interactive: () => false }

export const AskTextContext = createContext<AskTextRenderer>(PLAIN_TEXT)
