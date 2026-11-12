import Foundation

/// Keeps the launch splash up through a cold start that will open a server, so the connect page
/// never flashes between the splash and the server view's own cover. Bounded, whatever happens.
final class LaunchHold {
    static let maxMs: Int64 = 4000
    static let shared = LaunchHold { Int64(Date().timeIntervalSince1970 * 1000) }

    private let clock: () -> Int64
    private let lock = NSLock()
    private var until: Int64 = 0
    private var listener: (() -> Void)?

    init(clock: @escaping () -> Int64) {
        self.clock = clock
    }

    func start() {
        lock.lock()
        until = clock() + Self.maxMs
        lock.unlock()
    }

    /// The page has something else to show, or the server view is up. `onRelease` hears it, on the caller's thread.
    func release() {
        lock.lock()
        until = 0
        let told = listener
        listener = nil
        lock.unlock()
        told?()
    }

    func holding() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return until != 0 && clock() < until
    }

    /// Runs once on the next `release`; replaces an earlier one.
    func onRelease(_ run: @escaping () -> Void) {
        lock.lock()
        listener = run
        lock.unlock()
    }
}
