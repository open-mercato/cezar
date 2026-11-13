/** The extension author surface: manifest schemas, the context API and lifecycle helpers.
 *  Host HTTP and IPC shapes are deliberately not exported. */
export * from './schemas.js'
import type { z } from 'zod'
import type {
  extensionFormSchema, extensionPanelSchema, ExtensionJsonValue, ExtensionPermission, ExtensionTaskContext,
  ExtensionTaskSummary, ExtensionTaskProposal, ExtensionProposalReceipt, ExtensionTaskNotification,
} from './schemas.js'

export type MaybePromise<T> = T | Promise<T>
export type Disposable = { dispose(): MaybePromise<unknown> }
export type ExtensionActionResult = { message?: string } | void
/** A command's input: the submitted form values, plus the host-asserted `runId` when the command
 *  is `task`-located and was run from a task. */
export type ExtensionCommandInput = Record<string, unknown> & Partial<ExtensionTaskContext>
export type ExtensionCommandHandler = (input: ExtensionCommandInput | undefined, context: ExtensionContext) => MaybePromise<ExtensionActionResult>
/** `context` is passed only to a `task`-located panel rendered inside a task; it is
 *  `undefined` everywhere else. */
export type ExtensionPanelProvider = (context?: Partial<ExtensionTaskContext>) => MaybePromise<z.input<typeof extensionPanelSchema>>

/** Fixed by the host. All data operations cross asynchronous IPC. */
export type ExtensionContext = Readonly<{
  projectId: string
  permissions: readonly ExtensionPermission[]
  commands: { register(id: string, handler: ExtensionCommandHandler): Disposable }
  panels: { register(id: string, provider: ExtensionPanelProvider): Disposable }
  chat: { register(id: string, factory: (credentials: Record<string, string>, services?: import('./chat.js').ChatBotServices) => MaybePromise<import('./chat.js').ExtensionChatAdapter>): Disposable }
  forms: { register(id: string, provider: () => MaybePromise<z.input<typeof extensionFormSchema>>): Disposable }
  tasks: {
    list(): Promise<ExtensionTaskSummary[]>
    /** One task of this project by id (the same shape as a `list()` item), or `null` when the
     *  project has no such task. Needs `project.read`, like `list()`. */
    get(runId: string): Promise<ExtensionTaskSummary | null>
    /** Returns a proposal receipt, never a launched task. */
    propose(input: ExtensionTaskProposal): Promise<ExtensionProposalReceipt>
  }
  storage: {
    get(key: string): Promise<ExtensionJsonValue | undefined>
    set(key: string, value: ExtensionJsonValue): Promise<null>
  }
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<null>
  }
  logger: { info(message: string): Promise<void>; error(message: string): Promise<void> }
  /** Informational events; reload the snapshot on resyncRequired. No durable replay. */
  taskEvents: { subscribe(handler: (event: ExtensionTaskNotification) => MaybePromise<void>): Disposable }
}>
export type ExtensionDefinition = {
  activate?(context: ExtensionContext): MaybePromise<Disposable | void>
  deactivate?(): MaybePromise<void>
}
/** Identity helper. The host loads the manifest separately from this lifecycle object. */
export function defineExtension<T extends ExtensionDefinition>(definition: T): T { return definition }
