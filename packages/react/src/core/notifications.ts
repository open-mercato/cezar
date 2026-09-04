export interface CezarNotification {
  title: string
  body?: string
  tag?: string
}

export interface CezarNotifications {
  notify(notification: CezarNotification): void | Promise<void>
}

/** The safe default: notification support is host-controlled and never prompts for permission. */
export function createNoopCezarNotifications(): CezarNotifications {
  return {
    notify: () => undefined,
  }
}
