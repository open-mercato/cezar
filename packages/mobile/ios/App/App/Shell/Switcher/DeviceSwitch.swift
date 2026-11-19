import Foundation

/// The device switcher's decisions: a row's status in plain words, its count, the order, and where a
/// switch lands. The sheet only draws them (switcher spec "Native list").
enum DeviceSwitch {
    enum Status: Equatable {
        /// Probing, inside the bound.
        case checking, online, offline
        /// Reachable in no useful way until someone acts; the words say why.
        case other(String)

        /// Online first, then offline (and still checking), then the rest.
        var group: Int {
            switch self {
            case .online: return 0
            case .offline, .checking: return 1
            case .other: return 2
            }
        }
    }

    /// One probe's answer: the status, and the counts when the computer told them.
    struct Reading: Equatable {
        let status: Status
        var attention: HealthAnswer.Attention?

        init(_ status: Status, attention: HealthAnswer.Attention? = nil) {
            self.status = status
            self.attention = attention
        }
    }

    struct Row: Equatable {
        let id: String
        let label: String
        let initials: String
        let color: String
        let current: Bool
        let status: Status
        let words: String
        /// Waiting plus failed, as last known; nil when never told.
        let need: Int?

        /// "3 need you" beside every row but the ticked one.
        var needWords: String? {
            guard !current, let need, need > 0 else { return nil }
            return need == 1 ? "1 needs you" : "\(need) need you"
        }

        var accessibilityLabel: String {
            [label, words, needWords, current ? "current" : nil].compactMap { $0 }.joined(separator: ", ")
        }

        /// While this row opens, the spinner stands for its status.
        var switchingLabel: String { "\(label), switching" }
    }

    static let cantConnect = "Can't connect"

    /// A relay link's status. Connecting stays checking: the sheet's bound turns it offline.
    static func status(_ kind: RelayStatus.Kind) -> Status {
        switch kind {
        case .ready: return .online
        case .idle, .connecting: return .checking
        case .relayDown, .cezarOffline, .notAnswering: return .offline
        case .emailUnconfirmed: return .other("Email not confirmed")
        case .accountRequired: return .other("Relay account needed")
        case .suspended: return .other("Suspended")
        case .termsRequiredDevice: return .other("Accept the terms")
        case .deviceRemoved: return .other("Removed from this computer")
        case .updateApp: return .other("Update the app")
        case .updateCezar: return .other("Update cezar")
        case .quota: return .other("Relay limit reached")
        case .broken: return .other(cantConnect)
        }
    }

    /// A health answer, for a direct server.
    static func status(_ kind: HealthAnswer.Kind) -> Status {
        switch kind {
        case .cezar: return .online
        case .unreachable, .cezarOffline, .notAnswering, .relayDown: return .offline
        case .basicGate, .loginPage: return .other("Sign in needed")
        case .emailUnconfirmed: return .other("Email not confirmed")
        case .accountRequired: return .other("Relay account needed")
        case .suspended: return .other("Suspended")
        case .termsRequiredDevice: return .other("Accept the terms")
        case .deviceRemoved: return .other("Removed from this computer")
        case .updateApp: return .other("Update the app")
        case .updateCezar: return .other("Update cezar")
        case .quota: return .other("Relay limit reached")
        case .localMode, .tlsFailure, .notCezar: return .other(cantConnect)
        }
    }

    /// "Online", "Offline since 14:02" (a date when not today), "Checking…", or the status's own words.
    static func words(_ status: Status, seenAt: Int64?, now: Int64, calendar: Calendar = .current, locale: Locale = .current) -> String {
        switch status {
        case .online: return "Online"
        case .checking: return "Checking…"
        case .other(let words): return words
        case .offline:
            guard let seenAt, seenAt > 0 else { return "Offline" }
            let seen = Date(timeIntervalSince1970: Double(seenAt) / 1000)
            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            let today = calendar.isDate(seen, inSameDayAs: Date(timeIntervalSince1970: Double(now) / 1000))
            formatter.setLocalizedDateFormatFromTemplate(today ? "jmm" : "dMMM")
            return "Offline since " + formatter.string(from: seen)
        }
    }

    /// The current one first, then online, offline, the rest; by need inside each, else list order.
    static func rows(_ servers: [ServerRecord], currentId: String?, readings: [String: Reading], book: DeviceBook, now: Int64,
                     calendar: Calendar = .current, locale: Locale = .current) -> [Row] {
        let rows = servers.map { server -> Row in
            let current = server.id == currentId
            let reading = readings[server.id]
            // The page on screen is up, whatever its probe said.
            let status = current ? .online : reading?.status ?? .checking
            let entry = book.entries[server.id]
            let need = reading?.attention?.need ?? entry?.need
            return Row(id: server.id, label: server.label, initials: DeviceIdentity.initials(server.label),
                       color: DeviceIdentity.color(server.label), current: current, status: status,
                       words: words(status, seenAt: entry?.seenAt, now: now, calendar: calendar, locale: locale), need: need)
        }
        return rows.enumerated().sorted { a, b in
            let left = (a.element.current ? 0 : 1, a.element.status.group, -(a.element.need ?? 0), a.offset)
            let right = (b.element.current ? 0 : 1, b.element.status.group, -(b.element.need ?? 0), b.offset)
            return left < right
        }.map(\.element)
    }
}
