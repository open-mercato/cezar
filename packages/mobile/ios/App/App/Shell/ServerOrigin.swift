import Foundation

/// An https scheme, host and port: the only identity a saved server has (spec Decision 2).
struct ServerOrigin: Equatable {
    enum Problem: Error { case cleartext, invalid }

    let host: String
    let port: Int

    /// Takes what the user typed. A bare host means https; http is refused, spec Q5.
    static func parse(_ input: String?) throws -> ServerOrigin {
        var text = (input ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text.contains(" ") || text.contains("\\") { throw Problem.invalid }
        if !text.contains("://") { text = "https://" + text }
        guard let parts = URLComponents(string: text) else { throw Problem.invalid }
        let scheme = (parts.scheme ?? "").lowercased()
        if scheme == "http" { throw Problem.cleartext }
        let rootPath = parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/"
        // A password in the URL is refused rather than stripped: it must never be stored or logged.
        guard scheme == "https", let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              rootPath, parts.query == nil, parts.fragment == nil else { throw Problem.invalid }
        return ServerOrigin(host: host.lowercased(), port: parts.port ?? 443)
    }

    var origin: String { port == 443 ? "https://\(host)" : "https://\(host):\(port)" }

    func url(_ path: String) -> String { origin + path }

    /// False for anything that does not parse, so an odd URL can never pass as this server.
    func sameOrigin(_ url: String?) -> Bool {
        guard let url, !url.contains("\\"), let parts = URLComponents(string: url), let urlHost = parts.host else { return false }
        return parts.scheme?.lowercased() == "https" && urlHost.lowercased() == host && (parts.port ?? 443) == port
    }
}
