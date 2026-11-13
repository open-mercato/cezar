import { randomUUID } from 'node:crypto';
import { forgetReplies, type InboundStateStore } from './state.ts';

/** Called with the bot lease held and its receive transport drained. The checkpoint and the
 *  disabled receivers are one state write, so an interruption never loses consent. */
export async function setAdapterSuspension(store: InboundStateStore, enabled: boolean, now: number): Promise<void> {
  store.assertReady();
  const before = store.snapshot();
  if (!enabled) {
    if (before.adapterSuspension?.after === before.configGeneration) return;
    const receivers = before.receivers.filter(row => row.enabled).map(({ receiverId, generation }) => ({ receiverId, generation }));
    if (!receivers.length) return;
    await store.change(state => {
      if (state.configGeneration !== before.configGeneration) throw Error('Chat configuration changed during adapter disable');
      for (const row of state.receivers) row.enabled = false;
      forgetReplies(state, () => true);
      state.configGeneration = randomUUID();
      state.adapterSuspension = { after: state.configGeneration, receivers };
    });
    return;
  }
  if (!before.adapterSuspension) return;
  await store.change(state => {
    const checkpoint = state.adapterSuspension;
    if (!checkpoint) return;
    // A newer user decision owns the state. Never restore over it.
    if (state.configGeneration === checkpoint.after) {
      for (const row of state.receivers) {
        if (!checkpoint.receivers.some(prior => prior.receiverId === row.receiverId && prior.generation === row.generation)) continue;
        row.enabled = true; row.generation = randomUUID(); row.acceptAfter = now;
        for (const grant of state.grants) if (grant.receiverId === row.receiverId) grant.enableGeneration = row.generation;
      }
      state.configGeneration = randomUUID();
    }
    delete state.adapterSuspension;
  });
}
