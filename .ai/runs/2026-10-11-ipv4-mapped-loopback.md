# Accept IPv4-mapped IPv6 loopback authorities

Goal: accept valid IPv4-mapped IPv6 loopback authorities in the local request-origin guard without weakening DNS-rebinding or CSRF protections.

Scope: `packages/cezar/src/server/capabilities.ts` and its focused tests only. No route, workflow, or general network-exposure changes.

## Implementation plan

### Phase 1: Parse and classify mapped loopback authorities

- [ ] 1.1 Add strict dotted-quad IPv4-tail expansion to IPv6 canonicalization.
- [ ] 1.2 Recognize only canonical IPv4-mapped addresses whose mapped IPv4 value is in 127.0.0.0/8.

### Phase 2: Regression and security coverage

- [ ] 2.1 Add valid bracketed/bare/ported and canonical-equivalent cases.
- [ ] 2.2 Add malformed, invalid-octet, non-loopback, spoofing, and authority ambiguity cases.
- [ ] 2.3 Run focused tests, full validation gate, and review the final diff.

## Risks

- IPv6 parsing is a trust boundary; malformed dotted tails must remain fail-closed.
- Mapped addresses must not broaden the allowlist beyond IPv4 loopback.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Parse and classify mapped loopback authorities

- [ ] 1.1 Add strict dotted-quad IPv4-tail expansion to IPv6 canonicalization.
- [ ] 1.2 Recognize only canonical IPv4-mapped addresses whose mapped IPv4 value is in 127.0.0.0/8.

### Phase 2: Regression and security coverage

- [ ] 2.1 Add valid bracketed/bare/ported and canonical-equivalent cases.
- [ ] 2.2 Add malformed, invalid-octet, non-loopback, spoofing, and authority ambiguity cases.
- [ ] 2.3 Run focused tests, full validation gate, and review the final diff.
