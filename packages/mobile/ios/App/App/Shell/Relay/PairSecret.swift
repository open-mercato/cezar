import Foundation

/// What either pairing credential gives: a locator, a PSK and, for a QR code, the key to pin (§ 9.2).
struct PairSecret {
    private static let hkdfSalt = Bytes.ascii("cezar-relay-pair-salt-v1")
    private static let codeSalt = Bytes.ascii("cezar-pair-code-v1")
    private static let codeIterations = 200_000
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".unicodeScalars)
    private static let qr = "cezar-pair:([0-9]+)(?:\\.(.*))?"
    private static let fields = "([A-Za-z0-9_-]{43})\\.([A-Za-z0-9_-]{43})\\.(.*)"
    /// Recognized for its message only, never parsed: an older cezar shows it (spec QR9).
    private static let oldLink = "https?://.*/p#[0-9].*"

    let relay: RelayOrigin
    let locatorBytes: [UInt8]
    let psk: [UInt8]
    /// cezar's X25519 key from a QR code; nil for a typed code, where the six digits carry the weight.
    let pinnedKey: [UInt8]?

    var locator: String { Bytes.base64url(locatorBytes) }

    /// The strict § 9.1 parser. `version` is read first, so a later layout still says "Update the app".
    static func fromQr(_ text: String?, debugBuild: Bool) throws -> PairSecret {
        let qrText = text ?? ""
        guard let match = RelayRegex.groups(qr, qrText, dotAll: true) else {
            throw RelayOrigin.Refused(reason: RelayRegex.groups(oldLink, qrText, dotAll: true) != nil ? "old-link" : "grammar")
        }
        if match[1] != "1" { throw RelayOrigin.Refused(reason: "version") }
        guard let parts = RelayRegex.groups(fields, match[2] ?? "", dotAll: true) else { throw RelayOrigin.Refused(reason: "grammar") }
        guard let secret = Bytes.fromBase64url(parts[1], length: 32), let key = Bytes.fromBase64url(parts[2], length: 32) else {
            throw RelayOrigin.Refused(reason: "grammar")
        }
        let relay = try RelayOrigin.parse(parts[3] ?? "", debugBuild: debugBuild)
        return PairSecret(relay: relay, locatorBytes: hkdfLabel(secret, "cezar-pair-locator-v1"), psk: hkdfLabel(secret, "cezar-pair-psk-v1"),
                          pinnedKey: key)
    }

    private static func hkdfLabel(_ secret: [UInt8], _ info: String) -> [UInt8] {
        RelayCrypto.hkdf(secret, salt: hkdfSalt, info: Bytes.ascii(info), length: 32)
    }

    /// Normalizes a typed code under § 9.2; nil when refused.
    static func normalizeCode(_ typed: String?) -> String? {
        guard let typed else { return nil }
        var out = ""
        for scalar in typed.unicodeScalars {
            var c = scalar
            // Space, hyphen-minus and U+2010…U+2015, the dashes a keyboard may substitute.
            if c == " " || c == "-" || (c.value >= 0x2010 && c.value <= 0x2015) { continue }
            if c.value >= 0x61 && c.value <= 0x7a { c = Unicode.Scalar(c.value - 0x20)! }
            if c == "O" { c = "0" }
            if c == "I" || c == "L" { c = "1" }
            if !alphabet.contains(c) { return nil }
            out.unicodeScalars.append(c)
        }
        return out.unicodeScalars.count == 12 ? out : nil
    }

    /// Slow on purpose, 200,000 rounds: call it off the main thread.
    static func fromCode(_ typed: String?, relay: RelayOrigin) throws -> PairSecret {
        guard let code = normalizeCode(typed) else { throw RelayOrigin.Refused(reason: "grammar") }
        let okm = RelayCrypto.pbkdf2(password: Bytes.ascii(code), salt: codeSalt, iterations: codeIterations, length: 64)
        return PairSecret(relay: relay, locatorBytes: Array(okm[0..<32]), psk: Array(okm[32..<64]), pinnedKey: nil)
    }

    static func sasDigits(_ handshakeHash: [UInt8]) -> String {
        let out = RelayCrypto.hkdf(handshakeHash, salt: hkdfSalt, info: Bytes.ascii("cezar-pair-sas-v1"), length: 4)
        let n = (UInt32(out[0]) << 24) | (UInt32(out[1]) << 16) | (UInt32(out[2]) << 8) | UInt32(out[3])
        return String(format: "%06u", n % 1_000_000)
    }
}
