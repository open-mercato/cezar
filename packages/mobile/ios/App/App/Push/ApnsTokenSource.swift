import CryptoKit
import Foundation
import UIKit

/// APNs adapter, replacing FcmTokenSource. Without the `aps-environment` entitlement registration fails,
/// `available()` turns false and push is simply off, as Android is without `google-services.json`.
/// The AppDelegate forwards `didRegister…`/`didFailToRegister…` here.
final class ApnsTokenSource: TokenSource {
    static let shared = ApnsTokenSource()
    private static let timeoutSeconds: TimeInterval = 30
    /// A digest of the last token, never the token: enough to tell a rotation, useless to anyone else.
    private static let digestKey = "cezar.push.tokenDigest"

    private enum State { case idle, pending, registered(String), failed }

    private let condition = NSCondition()
    private var state = State.idle
    private let defaults: UserDefaults
    /// Set once by the app: `PushCoordinator.onNewToken` over the saved servers, off the main thread.
    var onTokenChanged: (() -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// At launch, main thread. Needs no user permission: only the alert does.
    @MainActor
    func register(_ application: UIApplication) {
        condition.lock()
        if case .registered = state {} else { state = .pending }
        condition.unlock()
        application.registerForRemoteNotifications()
    }

    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    func didRegister(deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        condition.lock()
        state = .registered(token)
        condition.broadcast()
        condition.unlock()
        let digest = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        let previous = defaults.string(forKey: Self.digestKey)
        defaults.set(digest, forKey: Self.digestKey)
        if let previous, previous != digest, let changed = onTokenChanged {
            DispatchQueue.global(qos: .utility).async(execute: changed)
        }
    }

    /// `application(_:didFailToRegisterForRemoteNotificationsWithError:)`: no entitlement, a simulator, no network.
    /// The error is not logged: it may name the bundle.
    func didFailToRegister() {
        condition.lock()
        if case .registered = state {} else { state = .failed }
        condition.broadcast()
        condition.unlock()
        PushLog.info("push token: registration failed")
    }

    /// True while registration is under way or done; false before it was asked and after it failed.
    func available() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        switch state {
        case .pending, .registered: return true
        case .idle, .failed: return false
        }
    }

    /// Waits for registration's answer, up to 30 s. Never on the main thread: the answer arrives there.
    func token() throws -> String {
        if Thread.isMainThread { throw NoTokenSource.Unavailable() }
        let deadline = Date(timeIntervalSinceNow: Self.timeoutSeconds)
        condition.lock()
        defer { condition.unlock() }
        while true {
            switch state {
            case .registered(let token): return token
            case .idle, .failed: throw NoTokenSource.Unavailable()
            case .pending:
                if !condition.wait(until: deadline) { throw NoTokenSource.Unavailable() }
            }
        }
    }
}
