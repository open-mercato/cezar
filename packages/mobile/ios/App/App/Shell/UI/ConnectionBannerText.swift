import Foundation

/// The native banner over a relay page: the spec's "How a failure appears in the app" table, and
/// nothing else. Pure; the root maps its relay status onto `Kind`.
struct ConnectionBannerText: Equatable {
    enum Kind { case idle, connecting, ready, relayDown, cezarOffline, notAnswering, quota, updateApp, updateCezar, deviceRemoved, broken }

    /// Under this, a reconnect shows nothing.
    static let graceMs: Int64 = 5000

    let text: String
    let retry: Bool

    /// Nil means no banner. A device removal is a full screen, not a banner.
    static func of(kind: Kind, retryAfterSeconds: Int64 = 0, notReadyForMs: Int64) -> ConnectionBannerText? {
        switch kind {
        case .updateApp: return ConnectionBannerText(text: "Update the app.", retry: false)
        case .updateCezar: return ConnectionBannerText(text: "Update cezar on your computer.", retry: false)
        case .broken:
            return ConnectionBannerText(text: "Something is wrong with this connection. Updating the app or cezar may help.", retry: true)
        default: break
        }
        if notReadyForMs < graceMs { return nil }
        switch kind {
        case .relayDown: return ConnectionBannerText(text: "Can't reach the Cezar relay. Your computer is fine. Retrying…", retry: true)
        case .cezarOffline: return ConnectionBannerText(text: "Your computer is asleep or cezar isn't running.", retry: true)
        case .notAnswering: return ConnectionBannerText(text: "cezar is not answering.", retry: true)
        case .quota:
            return ConnectionBannerText(text: "Too much traffic today. Back in \(max(1, (retryAfterSeconds + 59) / 60)) minutes.", retry: false)
        default: return nil
        }
    }
}
