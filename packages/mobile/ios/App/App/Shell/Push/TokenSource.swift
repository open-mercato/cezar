import Foundation

/// Where the phone's push token comes from: APNs in the app, a fake in tests. Never logged.
protocol TokenSource: AnyObject {
    /// False without a working push service, such as a build with no `aps-environment` entitlement: push is then off.
    func available() -> Bool

    /// Blocks; call it off the main thread.
    func token() throws -> String
}

/// `TokenSource.NONE`.
final class NoTokenSource: TokenSource {
    struct Unavailable: Error {}

    static let shared = NoTokenSource()

    func available() -> Bool { false }
    func token() throws -> String { throw Unavailable() }
}
