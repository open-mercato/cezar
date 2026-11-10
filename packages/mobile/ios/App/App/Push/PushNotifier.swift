import Foundation
import UserNotifications

/// The notification the app posts itself for a Stage 1 signal (spec R5), with the relay's own words
/// and grouping, and the permission behind both kinds.
final class PushNotifier {
    /// Android's channel id; a category here, so both kinds group alike.
    static let category = "attention"
    /// The same generic text the relay sends (§ 7). Never a server's words.
    static let title = "Cezar"
    static let body = "Cezar needs you"

    private let center: UNUserNotificationCenter
    private let servers: () -> [ServerRecord]
    private let lock = NSLock()
    /// The last answer of `getNotificationSettings`; nil until the first.
    private var cachedAllowed: Bool?

    /// `servers`: the saved list, so a forgotten server's signal posts nothing.
    init(center: UNUserNotificationCenter = .current(), servers: @escaping () -> [ServerRecord]) {
        self.center = center
        self.servers = servers
    }

    /// The system prompt, at most once per install; later calls answer from the setting. `done` runs on the main queue.
    func requestAuthorization(_ done: @escaping (Bool) -> Void) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] granted, _ in
            self?.refresh {
                DispatchQueue.main.async { done(granted && (self?.allowed() ?? false)) }
            }
        }
    }

    /// Re-reads the setting: at app foreground, since the user may change it in Settings.
    func refresh(_ done: (() -> Void)? = nil) {
        center.getNotificationSettings { [weak self] settings in
            self?.store(Self.allows(settings.authorizationStatus))
            done?()
        }
    }

    /// Android's `allowed()`. Off the main thread it asks the system when nothing is known yet; on the
    /// main thread it never waits, and answers false until the first refresh lands.
    func allowed() -> Bool {
        lock.lock()
        let known = cachedAllowed
        lock.unlock()
        if let known { return known }
        if Thread.isMainThread {
            refresh()
            return false
        }
        let done = DispatchSemaphore(value: 0)
        refresh { done.signal() }
        _ = done.wait(timeout: .now() + 2)
        lock.lock()
        defer { lock.unlock() }
        return cachedAllowed ?? false
    }

    /// One per cezar, replacing the last, like the relay's collapse key. `managerId` rides `userInfo` only.
    func post(cezarId: String, count: Int = 0, managerId: String? = nil) {
        guard PushTap.serverFor(cezarId, servers()) != nil, allowed() else { return }
        let content = UNMutableNotificationContent()
        content.title = Self.title
        content.body = Self.body
        content.sound = .default
        content.categoryIdentifier = Self.category
        content.threadIdentifier = cezarId
        content.userInfo = PushPayload.local(cezarId: cezarId, managerId: managerId)
        if count > 0 { content.badge = NSNumber(value: min(count, 99)) }
        center.add(UNNotificationRequest(identifier: cezarId, content: content, trigger: nil)) { error in
            // The permission went away between the check and the post.
            if error != nil { PushLog.info("push notification: not posted") }
        }
    }

    /// The relay's badge stays on the icon until the app clears it.
    func clearBadge() {
        center.setBadgeCount(0) { _ in }
    }

    private func store(_ value: Bool) {
        lock.lock()
        cachedAllowed = value
        lock.unlock()
    }

    private static func allows(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }
}
