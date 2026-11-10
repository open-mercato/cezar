import Foundation

/// Wire encodings of RELAY_PROTOCOL.md § 2. Bytes are `[UInt8]` throughout the relay code.
enum Bytes {
    static func ascii(_ text: String) -> [UInt8] { Array(text.utf8) }
    static func utf8(_ text: String) -> [UInt8] { Array(text.utf8) }

    static func concat(_ parts: [UInt8]...) -> [UInt8] { parts.flatMap { $0 } }

    static func base64url(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// Refuses padding, the `+/` alphabet and non-canonical trailing bits, as § 2 requires. Nil when refused.
    static func fromBase64url(_ text: String?) -> [UInt8]? {
        guard let text, !text.isEmpty, text.count % 4 != 1,
              text.unicodeScalars.allSatisfy({ CharacterSet.base64url.contains($0) }) else { return nil }
        var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while standard.count % 4 != 0 { standard += "=" }
        guard let data = Data(base64Encoded: standard) else { return nil }
        let bytes = [UInt8](data)
        return base64url(bytes) == text ? bytes : nil
    }

    /// Exactly `length` decoded bytes, or nil.
    static func fromBase64url(_ text: String?, length: Int) -> [UInt8]? {
        guard let bytes = fromBase64url(text), bytes.count == length else { return nil }
        return bytes
    }

    static func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }

    static func fromHex(_ text: String) -> [UInt8]? {
        guard text.count % 2 == 0 else { return nil }
        var out: [UInt8] = []
        out.reserveCapacity(text.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }
}

private extension CharacterSet {
    static let base64url = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
}

extension Bytes {
    /// Bouncy Castle's `constantTimeAreEqual`: lengths are not secret, contents are compared in full.
    static func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for i in 0..<a.count { difference |= a[i] ^ b[i] }
        return difference == 0
    }
}
