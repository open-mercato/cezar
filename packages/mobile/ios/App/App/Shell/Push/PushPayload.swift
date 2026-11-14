import Foundation

/// A notification's `userInfo`, both kinds: the relay's APNs payload carries only `s` (§ 7), and the
/// app's own Stage 1 notification adds `m`. The decisions CezarMessagingService and PushNotifier make on
/// Android, kept out of UserNotifications so they run on macOS.
enum PushPayload {
    /// The `userInfo` of the app's own notification. `managerId` rides only when plain.
    static func local(cezarId: String, managerId: String?) -> [String: String] {
        var info = [PushTap.extra: cezarId]
        if PushTap.validManagerId(managerId), let managerId { info[PushTap.extraManager] = managerId }
        return info
    }

    static func cezarId(_ userInfo: [AnyHashable: Any]) -> String? { userInfo[PushTap.extra] as? String }

    /// A tap on either kind: kept for the connect page's next launch, behind the lock (spec R5).
    static func offerTap(_ userInfo: [AnyHashable: Any]) {
        PushTap.offer(cezarId(userInfo), userInfo[PushTap.extraManager] as? String)
    }

    /// Whether to show a notification for this server now: one still saved, not over its own page, and
    /// not after its switch went off. A forgotten server's grant can outlive it (§ 7).
    static func shouldShow(cezarId: String?, servers: [ServerRecord], foreground: ForegroundServers, enabled: (String) -> Bool) -> Bool {
        guard let server = PushTap.serverFor(cezarId, servers) else { return false }
        return foreground.shouldNotify(server.id) && enabled(server.id)
    }
}
