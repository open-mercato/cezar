import Foundation

/// The exact `http://127.0.0.1:<port>` of a relay server's page: never a general `http` allowance (spec).
struct ProxyOrigin: Equatable, PageOrigin {
    let port: Int

    var origin: String { "http://127.0.0.1:\(port)" }

    func url(_ path: String) -> String { origin + path }

    func sameOrigin(_ url: String?) -> Bool {
        guard let parts = Self.parts(url) else { return false }
        return parts.scheme?.lowercased() == "http" && parts.host == "127.0.0.1" && parts.port == port
    }

    /// Every loopback spelling counts, so another port under any of them is blocked.
    func sameHost(_ url: String?) -> Bool {
        guard let host = Self.parts(url)?.host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    }

    var allowsSso: Bool { false }

    /// No user info and no backslash: either could make an odd URL pass as this origin.
    private static func parts(_ url: String?) -> URLComponents? {
        guard let url, !url.contains("\\"), let parts = URLComponents(string: url), parts.user == nil, parts.password == nil else { return nil }
        return parts
    }
}
