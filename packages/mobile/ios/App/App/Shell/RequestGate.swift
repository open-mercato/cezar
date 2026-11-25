import Foundation

/// iOS has no per-request hook like Android's `shouldInterceptRequest`, so a relay page's gate is a
/// WebKit content rule list: every loopback URL is blocked, then the page's own origin is let through.
/// Cookies ignore ports, so without it an `<img>` to another loopback port carries the gate cookie to
/// whatever app listens there (security review F1). `connect-src 'self'` covers only fetch and XHR.
enum RequestGate {
    /// WebKit's rule regexes have no alternation, so one rule per loopback spelling. Hosts are
    /// canonical by then: `http://2130706433/` already reads as 127.0.0.1.
    static let loopbackFilters = [
        "^[a-z][a-z0-9+.-]*://127\\.",
        "^[a-z][a-z0-9+.-]*://localhost",
        "^[a-z][a-z0-9+.-]*://0\\.0\\.0\\.0",
        "^[a-z][a-z0-9+.-]*://\\[[0:]*1\\]",
        "^[a-z][a-z0-9+.-]*://\\[::ffff:7f",
    ]

    static func identifier(port: Int) -> String { "cezar-loopback-gate-\(port)" }

    static func rules(port: Int) -> String {
        precondition((1...65535).contains(port), "bad port")
        let blocks = loopbackFilters.map { #"{"trigger":{"url-filter":"\#($0.replacingOccurrences(of: "\\", with: "\\\\"))"},"action":{"type":"block"}}"# }
        let own = #"{"trigger":{"url-filter":"^http://127\\.0\\.0\\.1:\#(port)/"},"action":{"type":"ignore-previous-rules"}}"#
        return "[" + (blocks + [own]).joined(separator: ",") + "]"
    }

    /// What the rules decide, for tests: WebKit's matcher is not available outside a web view.
    static func blocks(_ url: String, port: Int) -> Bool {
        func matches(_ pattern: String) -> Bool {
            url.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
        if matches("^http://127\\.0\\.0\\.1:\(port)/") { return false }
        return loopbackFilters.contains(where: matches)
    }
}
