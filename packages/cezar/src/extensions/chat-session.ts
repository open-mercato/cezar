import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { chatDeliverySchema, chatInteractionInputSchema, chatReceiveHealthSchema, chatTaskChoicesSchema, chatTaskQuerySchema, type ChatInteractionInput } from '@open-mercato/cezar-contract'
import type { ChatConnectionOptions, ReceiveJournal } from '../chat/connection.ts'
import { normalizeChatEvent } from '../chat/inbox.ts'

/** One leased bot's public services. No worker-supplied provider, project or vault identity. */
export class ChatReceiveServices {
  private accepting = false
  private choiceWindow = {at:0,count:0}
  private readonly choiceUsers = new Map<string,{at:number;count:number}>()
  private readonly interactions = new Map<string, { input: ChatInteractionInput; expires: number; used: boolean }>()
  constructor(private readonly journal: ReceiveJournal, private readonly options: ChatConnectionOptions,
    private readonly signal: AbortSignal, private readonly valid: () => boolean,
    private readonly model: 'ordered' | 'opaque', private readonly now: () => number = Date.now) {}
  private async guard() {
    this.signal.throwIfAborted()
    if (!this.valid() || !this.options.needed()) throw Error('Chat session retired')
    await this.options.assertCredentials()
    this.signal.throwIfAborted()
    if (!this.valid() || !this.options.needed()) throw Error('Chat session retired')
  }
  private async checkpoint() {
    const state = await this.journal.snapshot()
    return { epoch: state.epoch, nextSequence: state.nextOffset }
  }
  async dispatch(method: string, input: unknown): Promise<unknown> {
    await this.guard()
    switch (method) {
      case 'checkpoint': {
        if (this.accepting) throw Error('Acceptance in progress')
        await this.journal.prepareReceive(this.now(), this.model === 'ordered' ? 6 * 86400_000 : undefined)
        await this.guard()
        return this.checkpoint()
      }
      case 'health': {
        const { state } = chatReceiveHealthSchema.parse(input)
        this.options.onHealth(state === 'connecting' ? {state:'stopped',connecting:true} : state === 'polling' ? {state,lastSuccessfulPollAt:this.now()} : {state})
        return
      }
      case 'accept': {
        const delivery = chatDeliverySchema.parse(input)
        if ((delivery.kind === 'ordered') !== (this.model === 'ordered') || this.accepting) throw Error('Invalid receive delivery')
        this.accepting = true
        try {
          if (delivery.kind === 'ordered') {
            const checkpoint = await this.checkpoint()
            if (delivery.epoch !== checkpoint.epoch) throw Error('Stale receive epoch')
            if (await this.journal.duplicate(delivery.epoch, delivery.sequence)) {
              await this.journal.flush()
              await this.guard()
              return {disposition:'duplicate',checkpoint:await this.checkpoint()}
            }
            await this.guard()
            if (delivery.event) await this.options.process(normalizeChatEvent(delivery.event, delivery.sequence), delivery.epoch)
            await this.guard()
            await this.journal.finish(delivery.epoch, delivery.sequence)
            await this.journal.touch(this.now())
          } else {
            await this.options.accept(delivery.event)
          }
          await this.journal.flush()
          await this.guard()
          return {disposition:'accepted',checkpoint:await this.checkpoint()}
        } finally { this.accepting = false }
      }
      case 'openInteraction': {
        const value = chatInteractionInputSchema.parse(input), now = this.now()
        for (const [key, entry] of this.interactions) if (entry.expires <= now) this.interactions.delete(key)
        if (!this.options.nativeCommands || value.at < now - 3000 || value.at > now + 1000 || this.interactions.size >= 100) throw Error('Interaction unavailable')
        if (now - this.choiceWindow.at >= 60_000) this.choiceWindow = {at:now,count:0}
        for (const [key,window] of this.choiceUsers) if (now-window.at >= 60_000) this.choiceUsers.delete(key)
        const user = this.choiceUsers.get(value.user.id) ?? {at:now,count:0}
        if (this.choiceWindow.count >= 100 || user.count >= 30 || (!this.choiceUsers.has(value.user.id) && this.choiceUsers.size >= 100)) throw Error('Interaction rate limit')
        this.choiceWindow.count++; user.count++; this.choiceUsers.set(value.user.id,user)
        const handle = randomUUID()
        this.interactions.set(handle,{input:value,expires:now+3000,used:false})
        return {handle}
      }
      case 'taskChoices': {
        const {handle, query} = z.object({handle:z.string().uuid(),query:chatTaskQuerySchema}).strict().parse(input)
        const entry = this.interactions.get(handle)
        if (!entry || entry.used || entry.expires <= this.now()) throw Error('Interaction expired')
        entry.used = true
        let timer: ReturnType<typeof setTimeout> | undefined
        let choices
        try {
          choices = await Promise.race([this.options.nativeCommands!.tasks(query,entry.input.chat.id,entry.input.user.id),
            new Promise<never>((_,reject) => {timer=setTimeout(()=>reject(Error('Interaction deadline')),1000)})])
        } finally { clearTimeout(timer) }
        await this.guard()
        if (entry.expires <= this.now() || this.interactions.get(handle) !== entry) throw Error('Interaction expired')
        return chatTaskChoicesSchema.parse(choices)
      }
      case 'disposeInteraction': {
        const {handle} = z.object({handle:z.string().uuid()}).strict().parse(input)
        this.interactions.delete(handle)
        return
      }
    }
    throw Error('Unknown chat session service')
  }
}
