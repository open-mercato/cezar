export class TelegramInboundFailure extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 503, readonly code: string) { super(code); }
}
