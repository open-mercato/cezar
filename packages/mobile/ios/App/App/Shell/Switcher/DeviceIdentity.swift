import Foundation

/// A computer's automatic colour and initials, from its name alone: byte-identical with the cockpit and
/// Android (switcher spec "Automatic identity"), so the avatar matches wherever it is drawn.
enum DeviceIdentity {
    static let palette = ["#7c6cf0", "#e0912a", "#2fb862", "#2a9fd8", "#e05a73", "#22b3a0"]

    /// h = h*31 + c over the trimmed name's UTF-16 code units, mod 2^32.
    static func color(_ name: String) -> String {
        var hash: UInt32 = 0
        for unit in trimmed(name).utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return palette[Int(hash % UInt32(palette.count))]
    }

    /// Each word's first character, letters and digits only, the first two, upper case. Empty draws a laptop.
    static func initials(_ name: String) -> String {
        let words = trimmed(name).split(whereSeparator: { $0.unicodeScalars.allSatisfy(\.properties.isWhitespace) })
        var picked = ""
        for word in words {
            guard let first = word.unicodeScalars.first, isLetterOrDigit(first) else { continue }
            picked.unicodeScalars.append(first)
            if picked.unicodeScalars.count == 2 { break }
        }
        return picked.uppercased()
    }

    /// `\p{L}\p{N}`, as the cockpit's regex.
    private static func isLetterOrDigit(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    private static func trimmed(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
