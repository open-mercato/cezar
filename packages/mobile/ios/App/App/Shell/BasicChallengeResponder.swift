import Foundation

/// The parts of a URLAuthenticationChallenge this class decides on.
struct Challenge {
    let method: String
    let scheme: String?
    let host: String
    let port: Int
    let realm: String?
    let previousFailures: Int

    init(_ challenge: URLAuthenticationChallenge) {
        let space = challenge.protectionSpace
        method = space.authenticationMethod
        scheme = space.protocol
        host = space.host
        port = space.port
        realm = space.realm
        previousFailures = challenge.previousFailureCount
    }

    init(method: String, scheme: String?, host: String, port: Int, realm: String?, previousFailures: Int) {
        self.method = method
        self.scheme = scheme
        self.host = host
        self.port = port
        self.realm = realm
        self.previousFailures = previousFailures
    }
}

/// Answers the webview's Basic challenge for one saved server (spec Decision 2).
final class BasicChallengeResponder {
    enum Reply: Equatable {
        case answer(username: String, password: String)
        /// Server trust and the like: the system's own check runs. There is no TLS bypass.
        case systemDefault
        case cancelForeign
        case cancelRejected
    }

    private let server: ServerRecord
    private let origin: ServerOrigin?
    private let password: (String) -> String?

    init(server: ServerRecord, password: @escaping (String) -> String?) {
        self.server = server
        self.origin = server.origin
        self.password = password
    }

    /// One load can raise several challenges, one per path, so only a failed attempt means rejected.
    func onChallenge(_ challenge: Challenge) -> Reply {
        if challenge.method == NSURLAuthenticationMethodServerTrust { return .systemDefault }
        guard challenge.method == NSURLAuthenticationMethodHTTPBasic, let origin,
              challenge.scheme?.lowercased() == "https", challenge.host.lowercased() == origin.host, challenge.port == origin.port,
              let realm = server.realm, realm == (challenge.realm ?? "") else { return .cancelForeign }
        if challenge.previousFailures > 0 { return .cancelRejected }
        guard let saved = password(server.id) else { return .cancelRejected }
        return .answer(username: server.username ?? "", password: saved)
    }
}
