import Foundation

/// Noise's CipherState. Unaudited, thin over `RelayCrypto`: no maintained library has `XXpsk3`,
/// `KK` and `Rekey` (RELAY_PROTOCOL.md § 16, spec QR8). The counter is an unsigned 64-bit value.
final class NoiseCipher {
    /// Encrypting past 2^64 - 2 messages; Noise reserves 2^64 - 1 for Rekey. Java throws unchecked here.
    struct Exhausted: Error {}

    private static let maxNonce = UInt64.max

    private var key: [UInt8]?
    private(set) var nonce: UInt64

    init(_ key: [UInt8]?, nonce: UInt64 = 0) {
        self.key = key
        self.nonce = nonce
    }

    func copy() -> NoiseCipher { NoiseCipher(key, nonce: nonce) }

    var hasKey: Bool { key != nil }

    func encrypt(_ plaintext: [UInt8]) throws -> [UInt8] { try encrypt(ad: [], plaintext) }

    func encrypt(ad: [UInt8], _ plaintext: [UInt8]) throws -> [UInt8] {
        guard let key else { return plaintext }
        if nonce == Self.maxNonce { throw Exhausted() }
        let out = RelayCrypto.seal(key: key, counter: nonce, ad: ad, plaintext: plaintext)
        nonce += 1
        return out
    }

    func decrypt(_ ciphertext: [UInt8]) throws -> [UInt8] { try decrypt(ad: [], ciphertext) }

    func decrypt(ad: [UInt8], _ ciphertext: [UInt8]) throws -> [UInt8] {
        guard let key else { return ciphertext }
        if nonce == Self.maxNonce { throw RelayCrypto.DecryptFailure(message: "nonce exhausted") }
        let out = try RelayCrypto.open(key: key, counter: nonce, ad: ad, ciphertext: ciphertext)
        nonce += 1
        return out
    }

    /// Noise § 11.3: only the key changes, the counter carries on.
    func rekey() {
        guard let key else { return }
        let sealed = RelayCrypto.seal(key: key, counter: Self.maxNonce, ad: [], plaintext: [UInt8](repeating: 0, count: 32))
        self.key = Array(sealed[0..<32])
    }
}
