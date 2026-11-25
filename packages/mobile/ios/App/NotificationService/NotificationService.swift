import UserNotifications

/// Names a relay push on the phone: the relay sends only "Cezar", "Cezar needs you", a count and `s`, the
/// cezar id (§ 7). From the book the app keeps, `s` becomes the computer's name and the count becomes the
/// sum over every computer (switcher spec "Push"). Runs only for a payload with `mutable-content: 1`.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        original = request.content
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        let cezarId = content.userInfo["s"] as? String
        let badge = content.badge?.intValue
        let store = DeviceBookStore(storage: KeychainDeviceBookStorage())
        // An unknown cezar keeps the relay's words; `s` stays in userInfo, so a tap still opens its computer.
        if let named = store.update({ PushNaming.named(cezarId: cezarId, badge: badge, book: &$0) }) {
            content.title = named.title
            content.body = named.body
            content.badge = NSNumber(value: named.badge)
        }
        handler = nil
        contentHandler(content)
    }

    /// Out of time: the relay's own words.
    override func serviceExtensionTimeWillExpire() {
        if let handler, let original { handler(original) }
        handler = nil
    }
}
