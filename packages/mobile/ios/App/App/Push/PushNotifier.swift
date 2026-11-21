import Foundation
import UserNotifications

/// The notification the app posts itself for a Stage 1 signal (spec R5), naming the computer as the
/// Notification Service Extension names a relay push, and the permission behind both kinds.
final class PushNotifier {
    /// Android's channel id; a category here, so both kinds group alike.
    static let category = "attention"
    /// The same generic text the relay sends (§ 7). Never a server's words.
    static let title = "Cezar"
    static let body = "Cezar needs you"

    private let center: UNUserNotificationCenter
    private let servers: () -> [ServerRecord]
    private let book: DeviceBookStore
    private let lock = NSLock()
    /// The last answer of `getNotificationSettings`; nil until the first.
    private var cachedStatus: UNAuthorizationStatus?

    /// `servers`: the saved list, so a forgotten server's signal posts nothing.
    init(center: UNUserNotificationCenter = .current(), servers: @escaping () -> [ServerRecord], book: DeviceBookStore) {
        self.center = center
        self.servers = servers
        self.book = book
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
            self?.store(settings.authorizationStatus)
            done?()
        }
    }

    /// Android's `allowed()`. Off the main thread it asks the system when nothing is known yet; on the
    /// main thread it never waits, and answers false until the first refresh lands.
    func allowed() -> Bool {
        lock.lock()
        let known = cachedStatus
        lock.unlock()
        if let known { return Self.allows(known) }
        if Thread.isMainThread {
            refresh()
            return false
        }
        let done = DispatchSemaphore(value: 0)
        refresh { done.signal() }
        _ = done.wait(timeout: .now() + 2)
        lock.lock()
        defer { lock.unlock() }
        return cachedStatus.map(Self.allows) ?? false
    }

    /// Your cezars' `notifications`: `allowed`, `denied` or `unknown`, from the last refresh.
    func permission() -> String {
        lock.lock()
        defer { lock.unlock() }
        switch cachedStatus {
        case .some(.denied): return "denied"
        case .some(let status) where Self.allows(status): return "allowed"
        default: return "unknown"
        }
    }

    /// One per cezar, replacing the last, like the relay's collapse key. `managerId` rides `userInfo` only.
    /// Titled with the computer's name on this phone; the badge is the sum over every computer.
    func post(cezarId: String, count: Int? = nil, managerId: String? = nil) {
        let servers = servers()
        guard PushTap.serverFor(cezarId, servers) != nil, allowed() else { return }
        let named = book.update { book -> (title: String, body: String, badge: Int)? in
            book.sync(servers)
            return PushNaming.named(cezarId: cezarId, badge: count, book: &book)
        }
        let content = UNMutableNotificationContent()
        content.title = named?.title ?? Self.title
        content.body = named?.body ?? Self.body
        content.sound = .default
        content.categoryIdentifier = Self.category
        content.threadIdentifier = cezarId
        content.userInfo = PushPayload.local(cezarId: cezarId, managerId: managerId)
        if let badge = named?.badge { content.badge = NSNumber(value: badge) }
        center.add(UNNotificationRequest(identifier: cezarId, content: content, trigger: nil)) { error in
            // The permission went away between the check and the post.
            if error != nil { PushLog.info("push notification: not posted") }
        }
    }

    /// The sum of last-known per-computer counts (switcher spec "Push"). Without the extension a relay
    /// push leaves its own computer's count on the icon until the app opens and sets this.
    func showBadge(_ count: Int) {
        center.setBadgeCount(max(0, count)) { _ in }
    }

    /// The saved list's names, then the sum, as the app comes to the front.
    func refreshBadge() {
        settle()
    }

    /// The badge from the book, and a computer whose count is 0 loses its delivered notifications
    /// (spec 2026-11-20-phone-notifications-inbox, B3).
    func settle() {
        let servers = servers()
        let (badge, settled) = book.update { book -> (Int, Set<String>) in
            book.sync(servers)
            return (book.badge, book.settled)
        }
        showBadge(badge)
        guard !settled.isEmpty else { return }
        center.getDeliveredNotifications { [center] delivered in
            let ids = DeviceBook.toRemove(delivered.map { ($0.request.identifier, $0.request.content.userInfo[PushTap.extra] as? String) }, settled: settled)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    private func store(_ value: UNAuthorizationStatus) {
        lock.lock()
        cachedStatus = value
        lock.unlock()
    }

    private static func allows(_ status: UNAuthorizationStatus) -> Bool {
        switch status {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }
}
