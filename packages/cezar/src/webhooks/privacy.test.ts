import { describe, expect, it } from 'vitest';
import { scrubWebhookText } from './privacy.ts';

describe('webhook text path conventions', () => {
  it.each([
    ['Read "/home/alice/Private Files/task.ts" please.', 'Read … please.'],
    [String.raw`Read 'C:\Users\Alice Smith\task.ts' please.`, 'Read … please.'],
    ['Read `/srv/private project/task.ts` please.', 'Read … please.'],
    ['Failed (/opt/private/task.ts:42). Retry?', 'Failed (…?'],
    ['Read ~alice/private/secret.txt', 'Read …'],
    ['Read \"~alice.smith/private/secret.txt\" please.', 'Read … please.'],
    ['Open ./private/file or ../private/file?', 'Open …?'],
    ['Use /tmp/private.log, then /var/log/private.log.', 'Use ….'],
    ['Choose yes / no; divide 1 / 2.', 'Choose yes / no; divide 1 / 2.'],
    ['Review CI/CD, yes/no and 3/4.', 'Review CI/CD, yes/no and 3/4.'],
    ['See https://example.com/home/alice and /home/alice/private.', 'See https://example.com/home/alice and ….'],
    ['See [docs](https://example.com/docs/page).', 'See [docs](https://example.com/docs/page).'],
  ])('scrubs %s', (input, expected) => {
    expect(scrubWebhookText(input)).toBe(expected);
    expect(scrubWebhookText(scrubWebhookText(input))).toBe(expected);
  });
});
