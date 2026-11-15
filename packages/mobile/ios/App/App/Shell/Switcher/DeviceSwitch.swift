import Foundation

/// The device switcher's decisions: a row's status, its words, and where a switch lands. The sheet only draws them.
enum DeviceSwitch {
    enum Status: Equatable {
        /// Probing, inside the bound: grey, as offline.
        case checking, connected, offline, attention, blocked

        /// What VoiceOver reads after the label.
        var words: String {
            switch self {
            case .checking: return "checking"
            case .connected: return "connected"
            case .offline: return "offline"
            case .attention: return "needs attention"
            case .blocked: return "blocked"
            }
        }
    }

    struct Row: Equatable {
        let id: String
        let label: String
        let detail: String
        let current: Bool
        let status: Status

        var accessibilityLabel: String {
            "\(label), \(status.words)" + (current ? ", current" : "")
        }

        /// While this row opens, the spinner stands for its status.
        var switchingLabel: String { "\(label), switching" }
    }

    /// A relay link's status. Connecting stays checking: the sheet's bound turns it offline.
    static func status(_ kind: RelayStatus.Kind) -> Status {
        switch kind {
        case .ready: return .connected
        case .idle, .connecting: return .checking
        case .emailUnconfirmed, .accountRequired, .updateApp, .updateCezar: return .attention
        case .suspended, .termsRequiredDevice, .deviceRemoved: return .blocked
        case .relayDown, .cezarOffline, .notAnswering, .quota, .broken: return .offline
        }
    }

    /// A health answer, for a direct server.
    static func status(_ kind: HealthAnswer.Kind) -> Status {
        switch kind {
        case .cezar: return .connected
        case .basicGate, .loginPage, .localMode, .updateApp, .updateCezar, .emailUnconfirmed, .accountRequired: return .attention
        case .suspended, .termsRequiredDevice, .deviceRemoved: return .blocked
        case .tlsFailure, .unreachable, .notCezar, .cezarOffline, .notAnswering, .relayDown, .quota: return .offline
        }
    }

    /// The row's second line.
    static func detail(_ server: ServerRecord) -> String {
        if server.relay != nil { return "Through the relay" }
        return server.origin?.host ?? server.url ?? ""
    }

    /// In list order. The current server's page is up, so it reads connected.
    static func rows(_ servers: [ServerRecord], currentId: String?, statuses: [String: Status]) -> [Row] {
        servers.map { server in
            let current = server.id == currentId
            return Row(id: server.id, label: server.label, detail: detail(server), current: current,
                       status: current ? .connected : statuses[server.id] ?? .checking)
        }
    }
}
