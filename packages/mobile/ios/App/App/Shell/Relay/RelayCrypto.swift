import CommonCrypto
import CryptoKit
import Foundation
import Security

/// Every primitive this client uses, each a direct call into CryptoKit or CommonCrypto. None is written here.
enum RelayCrypto {
    struct DecryptFailure: Error, Equatable {
        let message: String
    }

    static func random(_ length: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: length)
        guard SecRandomCopyBytes(kSecRandomDefault, length, &out) == errSecSuccess else {
            fatalError("no system randomness")
        }
        return out
    }

    static func sha256(_ parts: [UInt8]...) -> [UInt8] {
        var hasher = SHA256()
        for part in parts { hasher.update(data: part) }
        return Array(hasher.finalize())
    }

    static func hmacSha256(key: [UInt8], _ parts: [UInt8]...) -> [UInt8] {
        var mac = HMAC<SHA256>(key: SymmetricKey(data: key))
        for part in parts { mac.update(data: part) }
        return Array(mac.finalize())
    }

    /// RFC 5869, the § 9.2 derivations.
    static func hkdf(_ ikm: [UInt8], salt: [UInt8], info: [UInt8], length: Int) -> [UInt8] {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: length)
        return key.withUnsafeBytes { Array($0) }
    }

    static func pbkdf2(password: [UInt8], salt: [UInt8], iterations: Int, length: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: length)
        let status = password.withUnsafeBufferPointer { pass in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pass.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self) },
                                 pass.count, salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(iterations), &out, length)
        }
        precondition(status == kCCSuccess, "PBKDF2 failed")
        return out
    }

    static func x25519Secret() -> [UInt8] { random(32) }

    static func x25519Public(_ secret: [UInt8]) -> [UInt8] {
        // A 32-byte secret is always accepted; CryptoKit clamps it as RFC 7748 does.
        Array(try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret).publicKey.rawRepresentation)
    }

    /// Refuses an all-zero output, in `XXpsk3` and `KK` (§ 9.3).
    static func x25519(_ secret: [UInt8], _ peer: [UInt8]) throws -> [UInt8] {
        let out: [UInt8]
        do {
            let key = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
            let shared = try key.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer))
            out = shared.withUnsafeBytes { Array($0) }
        } catch {
            throw DecryptFailure(message: "low-order X25519 key")
        }
        guard out.count == 32, out.contains(where: { $0 != 0 }) else { throw DecryptFailure(message: "low-order X25519 key") }
        return out
    }

    static func ed25519Public(_ seed: [UInt8]) -> [UInt8] {
        Array(try! Curve25519.Signing.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation)
    }

    /// CryptoKit signs with added randomness, so a signature here never equals a vector's; it verifies (vectors README).
    static func ed25519Sign(_ seed: [UInt8], _ message: [UInt8]) -> [UInt8] {
        Array(try! Curve25519.Signing.PrivateKey(rawRepresentation: seed).signature(for: message))
    }

    static func ed25519Verify(_ publicKey: [UInt8], _ message: [UInt8], _ signature: [UInt8]) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }

    /// ChaCha20-Poly1305 with Noise's nonce: four zero bytes, then the counter as a little-endian uint64 (§ 16).
    static func seal(key: [UInt8], counter: UInt64, ad: [UInt8], plaintext: [UInt8]) -> [UInt8] {
        let box = try! ChaChaPoly.seal(plaintext, using: SymmetricKey(data: key), nonce: nonce(counter), authenticating: ad)
        return Array(box.ciphertext) + Array(box.tag)
    }

    static func open(key: [UInt8], counter: UInt64, ad: [UInt8], ciphertext: [UInt8]) throws -> [UInt8] {
        guard ciphertext.count >= 16 else { throw DecryptFailure(message: "ciphertext too short") }
        do {
            let box = try ChaChaPoly.SealedBox(nonce: nonce(counter), ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
            return Array(try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad))
        } catch {
            throw DecryptFailure(message: "authentication failed")
        }
    }

    private static func nonce(_ counter: UInt64) -> ChaChaPoly.Nonce {
        var bytes = [UInt8](repeating: 0, count: 12)
        for i in 0..<8 { bytes[4 + i] = UInt8(truncatingIfNeeded: counter >> (8 * UInt64(i))) }
        return try! ChaChaPoly.Nonce(data: bytes)
    }
}
