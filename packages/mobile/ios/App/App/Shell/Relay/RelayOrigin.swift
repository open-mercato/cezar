import Foundation

/// A relay address: scheme, host and port, no path (RELAY_PROTOCOL.md § 3, § 9.1).
struct RelayOrigin: Equatable {
    struct Refused: Error, Equatable {
        /// `version`, `old-link`, `cleartext` or `grammar`, the reasons in qr.json.
        let reason: String
    }

    /// The app's one copy of the default relay, the twin of cezar's DEFAULT_RELAY_ORIGIN.
    static let defaultOrigin = "https://rome.patzick.workers.dev"

    static let pattern = "(https|http)://([a-z0-9.-]+|\\[::1\\])(?::([1-9][0-9]{0,4}))?"

    let origin: String
    let socketOrigin: String

    /// The strict `origin` production. `debugBuild` is what admits the `http` rows of § 9.1.
    static func parse(_ text: String?, debugBuild: Bool) throws -> RelayOrigin {
        let groups = try matched(text)
        let text = text ?? ""
        let secure = groups[1] == "https"
        if !secure && !(debugBuild && isDevHost(groups[2] ?? "")) { throw Refused(reason: "cleartext") }
        return RelayOrigin(origin: text, socketOrigin: (secure ? "wss" : "ws") + text.dropFirst(secure ? 5 : 4))
    }

    /// The production alone, with no word on which schemes this build allows.
    static func matched(_ text: String?) throws -> [String?] {
        guard let groups = RelayRegex.groups(pattern, text ?? "") else { throw Refused(reason: "grammar") }
        if let port = groups[3], (Int(port) ?? Int.max) > 65535 { throw Refused(reason: "grammar") }
        return groups
    }

    /// What the Enter code field takes: `https://` is assumed with no scheme, one trailing `/` goes.
    static func parseTyped(_ text: String?, debugBuild: Bool) throws -> RelayOrigin {
        var typed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if typed.hasSuffix("/") { typed.removeLast() }
        if !typed.contains("://") { typed = "https://" + typed }
        return try parse(typed, debugBuild: debugBuild)
    }

    /// Enter code's address: an empty field is the default relay, anything else stays under the typed rules.
    static func parseTypedOrDefault(_ text: String?, debugBuild: Bool) throws -> RelayOrigin {
        let blank = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return blank ? try parse(defaultOrigin, debugBuild: debugBuild) : try parseTyped(text, debugBuild: debugBuild)
    }

    private static func isDevHost(_ host: String) -> Bool {
        host == "127.0.0.1" || host == "localhost" || host == "[::1]"
    }
}
