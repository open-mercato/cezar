import Foundation
import UserNotifications

/// The notification center's delegate, replacing CezarMessagingService and MainActivity's tap path.
/// In the background the system shows the relay's fixed notification itself; this covers the
/// foreground and the tap. Set as the delegate before launch finishes, or a cold-launch tap is lost.
final class PushReceiver: NSObject, UNUserNotificationCenterDelegate {
    private let servers: () -> [ServerRecord]
    private let enabled: (String) -> Bool
    private let foreground: ForegroundServers
    /// Posts the app's own notification for this cezar and count, naming the computer. Off the main thread.
    private let repost: (String, Int?) -> Void
    /// After a tap is recorded: the app reloads the connect page, whose `launch()` takes it (Android's `bridge.reload()`).
    private let onTap: () -> Void

    init(servers: @escaping () -> [ServerRecord], enabled: @escaping (String) -> Bool,
         foreground: ForegroundServers = .shared, repost: @escaping (String, Int?) -> Void, onTap: @escaping () -> Void) {
        self.servers = servers
        self.enabled = enabled
        self.foreground = foreground
        self.repost = repost
        self.onTap = onTap
    }

    /// The app is in front. Our own (Stage 1) was checked when posted; the relay's gets the same checks
    /// now: not over that server's own page, and not after its switch went off. A relay push the
    /// extension did not rename (no `mutable-content` yet) is shown as our own, named one instead.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let content = notification.request.content
        let remote = notification.request.trigger is UNPushNotificationTrigger
        if remote && !PushPayload.shouldShow(cezarId: PushPayload.cezarId(content.userInfo), servers: servers(),
                                             foreground: foreground, enabled: enabled) {
            completionHandler([])
            return
        }
        if remote, content.title == PushNotifier.title, let cezarId = PushPayload.cezarId(content.userInfo) {
            completionHandler([])
            let count = content.badge?.intValue
            DispatchQueue.global(qos: .userInitiated).async { self.repost(cezarId, count) }
            return
        }
        completionHandler([.banner, .list, .sound, .badge])
    }

    /// A tap on either kind: `s` (and a local one's `m`) for the connect page's next launch, behind the lock.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            PushPayload.offerTap(response.notification.request.content.userInfo)
            DispatchQueue.main.async(execute: onTap)
        }
        completionHandler()
    }
}
