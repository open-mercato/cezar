import { createHash } from 'node:crypto';

import type { QuestionItem, QuestionsTopicFrame } from '@open-mercato/cezar-contract';
import type { TopicPublisher } from '../server/ws.ts';
import type { QuestionInbox } from './inbox.ts';

/** Older is time-based, so nothing fires when a question crosses it: re-count this often while subscribed. */
export const QUESTIONS_TOPIC_RECOUNT_MS = 60_000;

/** A short digest of what the open list shows: a re-ask that closes one card and opens another keeps the counts. */
export function openRevision(open: readonly QuestionItem[]): string {
  const rows = open.map((item) => [item.key, item.older, item.stale?.why ?? '', item.linked?.key ?? ''].join('|')).sort();
  return createHash('sha1').update(rows.join('\n')).digest('base64url').slice(0, 12);
}

/**
 * The `questions` WebSocket topic (spec `.ai/specs/2026-11-17-questions-inbox.md` § Counts): `{ live, older, revision }`,
 * published only when it changed. Demand-driven like every topic (spec 2026-07-23-websocket-subscriptions):
 * the inbox listener and the recount timer exist only while someone subscribes.
 */
export function questionsTopic(inbox: QuestionInbox, recountMs = QUESTIONS_TOPIC_RECOUNT_MS): TopicPublisher {
  let last: string | undefined;
  const read = async (): Promise<QuestionsTopicFrame> => {
    const { open, counts } = await inbox.list();
    return { ...counts, revision: openRevision(open) };
  };
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
