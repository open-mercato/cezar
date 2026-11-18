export class ChatInboundFailure extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 503, readonly code: string, options?: ErrorOptions) { super(code, options); }
}
