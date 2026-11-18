import type { QuestionCounts } from '@open-mercato/cezar-contract';
import type { TopicPublisher } from '../server/ws.ts';
import type { QuestionInbox } from './inbox.ts';

/** Older is time-based, so nothing fires when a question crosses it: re-count this often while subscribed. */
export const QUESTIONS_TOPIC_RECOUNT_MS = 60_000;

/**
 * The `questions` WebSocket topic (spec `.ai/specs/2026-11-17-questions-inbox.md` § Counts): `{ live, older }`,
 * published only when it changed. Demand-driven like every topic (spec 2026-07-23-websocket-subscriptions):
 * the inbox listener and the recount timer exist only while someone subscribes.
 */
export function questionsTopic(inbox: QuestionInbox, recountMs = QUESTIONS_TOPIC_RECOUNT_MS): TopicPublisher {
  let last: string | undefined;
  const read = (): Promise<QuestionCounts> => inbox.counts();
  return {
    snapshot: async () => {
      const counts = await read();
      last = JSON.stringify(counts);
      return counts;
    },
    start(publish) {
      let stopped = false;
      let pending: Promise<void> | undefined;
      let again = false;
      const recount = (): void => {
        if (pending) {
          again = true;
          return;
        }
        pending = read()
          .then((counts) => {
            const body = JSON.stringify(counts);
            if (stopped || body === last) return;
            last = body;
            publish(counts);
          })
          .catch(() => {})
          .finally(() => {
            pending = undefined;
            if (again && !stopped) {
              again = false;
              recount();
            }
          });
      };
      const off = inbox.onChange(recount);
      const timer = setInterval(recount, recountMs);
      timer.unref?.();
      return () => {
        stopped = true;
        off();
        clearInterval(timer);
        last = undefined;
      };
    },
  };
}
