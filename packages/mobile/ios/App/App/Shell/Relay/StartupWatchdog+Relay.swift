import Foundation

extension StartupWatchdog {
    /// Android's `terminalReason`/`connectReason`. Refusals that leave the page (§ 18, a removed phone) are the view's.
    func relayStatus(_ kind: RelayStatus.Kind, computer: String?, now: Int64) {
        relayStatus(ready: kind == .ready, terminal: Self.terminalReason(kind), connectProblem: Self.connectReason(kind, computer: computer), now: now)
    }

    static func terminalReason(_ kind: RelayStatus.Kind) -> String? {
        switch kind {
        case .updateApp: return "Update the app: this cezar needs a newer one."
        case .updateCezar: return "Update cezar on your computer: this app needs a newer one."
        case .broken: return "Something is wrong with this connection. Updating the app or cezar may help."
        default: return nil
        }
    }

    static func connectReason(_ kind: RelayStatus.Kind, computer: String?) -> String {
        let name = (computer?.isEmpty ?? true) ? "Your computer" : computer!
        switch kind {
        case .relayDown: return "Can't reach the Cezar relay."
        case .cezarOffline: return "\(name) is asleep or offline."
        case .notAnswering: return "cezar is not answering the secure handshake."
        case .quota: return "The relay is over today's traffic limit."
        default: return "The relay connection timed out."
        }
    }
}
