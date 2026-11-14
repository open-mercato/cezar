import Foundation
import os

/// The few `org.json` calls the Android push code makes, over JSONSerialization.
enum PushJson {
    /// A JSON object, or nil for anything else (an array, a bare value, bad bytes).
    static func object(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// `JSONObject.quote`: one string as a JSON literal, quotes included.
    static func quote(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
    }

    static func text(_ body: [String: Any], _ key: String) -> String? { body[key] as? String }

    /// `optLong`: a JSON number, else the fallback. A Bool is not a number here.
    static func long(_ body: [String: Any], _ key: String, _ fallback: Int64 = 0) -> Int64 {
        guard let number = body[key] as? NSNumber, !isBool(number) else { return fallback }
        return number.int64Value
    }

    static func bool(_ body: [String: Any], _ key: String) -> Bool {
        guard let number = body[key] as? NSNumber, isBool(number) else { return false }
        return number.boolValue
    }

    static func string(_ body: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.withoutEscapingSlashes]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    private static func isBool(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }
}

/// `Logger.getLogger("cezar.push")`. Statuses only, never a grant or a token.
enum PushLog {
    private static let logger = Logger(subsystem: "com.openmercato.cezar.mobile", category: "push")

    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
    }
}
