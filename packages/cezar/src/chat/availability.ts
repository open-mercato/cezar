export type ChatUnavailableReason = 'hosted' | 'webhooks_off' | 'flag_off';
export type ChatNotificationsUnavailableReason = Exclude<ChatUnavailableReason, 'flag_off'>;

/** The gate for task control (replies, commands, grants): hosted or either flag off answers empty. */
export function chatUnavailableReason(mode: 'local' | 'hosted', env: NodeJS.ProcessEnv = process.env): ChatUnavailableReason | undefined {
  return chatNotificationsUnavailableReason(mode, env) ?? (env.CEZ_CHAT_INBOUND !== '1' ? 'flag_off' : undefined);
}
/** Notifications and their setup need only CEZ_WEBHOOKS=1 (spec 2026-10-29-telegram-setup-and-replies). */
export function chatNotificationsUnavailableReason(mode: 'local' | 'hosted', env: NodeJS.ProcessEnv = process.env): ChatNotificationsUnavailableReason | undefined {
  return mode !== 'local' ? 'hosted' : env.CEZ_WEBHOOKS !== '1' ? 'webhooks_off' : undefined;
}
/** Task control off only through CEZ_CHAT_INBOUND still leaves notifications working. */
export function notificationsReason<R extends string>(reason: R | 'flag_off' | undefined): Exclude<R, 'flag_off'> | undefined {
  return reason === 'flag_off' ? undefined : reason as Exclude<R, 'flag_off'> | undefined;
}
