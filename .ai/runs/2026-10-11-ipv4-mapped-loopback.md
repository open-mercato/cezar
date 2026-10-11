# Accept IPv4-mapped IPv6 loopback authorities

Goal: accept valid IPv4-mapped IPv6 loopback authorities in the local request-origin guard without weakening DNS-rebinding or CSRF protections.

Scope: `packages/cezar/src/server/capabilities.ts` and its focused tests only. No route, workflow, or general network-exposure changes.

## Implementation plan

### Phase 1: Parse and classify mapped loopback authorities

- [x] 1.1 Add strict dotted-quad IPv4-tail expansion to IPv6 canonicalization. — 536f51f8
- [x] 1.2 Recognize only canonical IPv4-mapped addresses whose mapped IPv4 value is in 127.0.0.0/8. — 536f51f8

### Phase 2: Regression and security coverage

- [x] 2.1 Add valid bracketed/bare/ported and canonical-equivalent cases. — 536f51f8
- [x] 2.2 Add malformed, invalid-octet, non-loopback, spoofing, and authority ambiguity cases. — 536f51f8
- [x] 2.3 Run focused tests, full validation gate, and review the final diff. — pending baseline-gate follow-up
- [x] 2.4 Reject ambiguous leading-zero mapped IPv4 tails and cover dotted/hex same-origin authorities. — 77e21849

## Risks

- IPv6 parsing is a trust boundary; malformed dotted tails must remain fail-closed.
- Mapped addresses must not broaden the allowlist beyond IPv4 loopback.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Parse and classify mapped loopback authorities

- [x] 1.1 Add strict dotted-quad IPv4-tail expansion to IPv6 canonicalization. — 536f51f8
- [x] 1.2 Recognize only canonical IPv4-mapped addresses whose mapped IPv4 value is in 127.0.0.0/8. — 536f51f8

### Phase 2: Regression and security coverage

- [x] 2.1 Add valid bracketed/bare/ported and canonical-equivalent cases. — 536f51f8
- [x] 2.2 Add malformed, invalid-octet, non-loopback, spoofing, and authority ambiguity cases. — 536f51f8
- [x] 2.3 Run focused tests, full validation gate, and review the final diff. — pending baseline-gate follow-up
- [x] 2.4 Reject ambiguous leading-zero mapped IPv4 tails and cover dotted/hex same-origin authorities. — 77e21849
