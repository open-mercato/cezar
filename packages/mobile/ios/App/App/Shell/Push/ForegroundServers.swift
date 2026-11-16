import Foundation

/// Which servers' pages are on screen. A signal for one of them shows nothing: the user is looking at it (spec R5, Stage 1).
final class ForegroundServers {
    static let shared = ForegroundServers()

    private let lock = NSLock()
    private var started: [String: Int] = [:]

    func started(_ serverId: String?) {
        guard let serverId else { return }
        lock.lock()
        defer { lock.unlock() }
        started[serverId, default: 0] += 1
    }

    func stopped(_ serverId: String?) {
        guard let serverId else { return }
        lock.lock()
        defer { lock.unlock() }
        guard let count = started[serverId] else { return }
        started[serverId] = count <= 1 ? nil : count - 1
    }

    /// Whether a signal for this server raises a notification.
    func shouldNotify(_ serverId: String?) -> Bool {
        guard let serverId else { return false }
        lock.lock()
        defer { lock.unlock() }
        return started[serverId] == nil
    }
}
