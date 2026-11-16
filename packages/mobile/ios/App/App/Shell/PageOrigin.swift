import Foundation

/// What the gates need from either kind of server page: `ServerOrigin` or `ProxyOrigin`.
protocol PageOrigin {
    var origin: String { get }
    func url(_ path: String) -> String
    func sameOrigin(_ url: String?) -> Bool
    func sameHost(_ url: String?) -> Bool
    /// Whether an `https` redirect may leave in-app, for an SSO login. Manual servers only.
    var allowsSso: Bool { get }
}
