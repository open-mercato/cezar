import Foundation

/// One HTTP response. Header names are lower case.
struct HttpAnswer {
    let status: Int
    let headers: [String: String]
    let body: String
}

/// What `GET /api/v1/health` said, in the terms of the add-server table (spec Decision 2).
struct HealthAnswer {
    enum Kind { case cezar, basicGate, localMode, loginPage, tlsFailure, unreachable, notCezar }

    let kind: Kind
    let status: Int
    /// The Basic realm, when `.basicGate`.
    var realm: String?
    var version: String?
    /// `capabilities.managers`; nil when the server does not send it.
    var managers: Bool?
}

/// Maps a raw health response onto the spec's add-server table. Network-free.
enum HealthClassifier {
    static func classify(_ http: HttpAnswer) -> HealthAnswer {
        let status = http.status
        if status == 401, let challenge = http.headers["www-authenticate"], isBasic(challenge) {
            return HealthAnswer(kind: .basicGate, status: status, realm: realm(of: challenge))
        }
        let json = object(http.body)
        if status == 200, let json {
            guard let version = json["version"] as? String, !version.isEmpty,
                  let capabilities = json["capabilities"] as? [String: Any] else {
                return HealthAnswer(kind: .notCezar, status: status)
            }
            return HealthAnswer(kind: .cezar, status: status, version: version, managers: capabilities["managers"] as? Bool)
        }
        // server.ts answers `{ error: 'unexpected Host header' }` on a local-mode cockpit.
        if status == 403, let error = json?["error"] as? String, error.lowercased().contains("host header") {
            return HealthAnswer(kind: .localMode, status: status)
        }
        let html = (http.headers["content-type"] ?? "").lowercased().contains("text/html")
        if (300..<400).contains(status) || ([200, 401, 403].contains(status) && html) {
            return HealthAnswer(kind: .loginPage, status: status)
        }
        return HealthAnswer(kind: .notCezar, status: status)
    }

    private static func isBasic(_ challenge: String) -> Bool {
        let scheme = challenge.trimmingCharacters(in: .whitespaces).split(separator: " ").first ?? ""
        return scheme.lowercased() == "basic"
    }

    private static func object(_ body: String) -> [String: Any]? {
        guard body.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("{"), let data = body.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func realm(of challenge: String) -> String {
        let pattern = "realm=(?:\"((?:[^\"\\\\]|\\\\.)*)\"|([^\\s,]+))"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
              let match = regex.firstMatch(in: challenge, range: NSRange(challenge.startIndex..., in: challenge)) else { return "" }
        if let quoted = Range(match.range(at: 1), in: challenge) {
            return challenge[quoted].replacingOccurrences(of: "\\\\(.)", with: "$1", options: .regularExpression)
        }
        return Range(match.range(at: 2), in: challenge).map { String(challenge[$0]) } ?? ""
    }
}
