import Foundation

/// The device switcher's decisions: a row's status in plain words, its count, the order, and where a
/// switch lands. The sheet only draws them (switcher spec "Native list").
enum DeviceSwitch {
    enum Status: Equatable {
        /// Probing, inside the bound.
        case checking, online, offline
        /// Reachable in no useful way until someone acts; the reason says why.
        case other(Reason)

        /// Online first, then offline (and still checking), then the rest.
        var group: Int {
            switch self {
            case .online: return 0
            case .offline, .checking: return 1
            case .other: return 2
            }
        }

        /// The connect page's `status` (spec 2026-11-19-mobile-devices-screen, "Native ↔ page contract").
        var key: String {
            switch self {
            case .checking: return "checking"
            case .online: return "online"
            case .offline: return "offline"
            case .other: return "other"
            }
        }

        /// The page's `reason`, for `other` only.
        var reason: String? {
            guard case .other(let reason) = self else { return nil }
            return reason.rawValue
        }
    }

    /// Why a cezar is blocked: the page's `reason`, and the words every list shows for it.
    enum Reason: String, CaseIterable {
        case signIn = "sign-in", removed, email, account, terms, suspended
        case updateApp = "update-app", updateCezar = "update-cezar", quota, broken

        var words: String {
            switch self {
            case .signIn: return "Sign in needed"
            case .removed: return "This phone was removed"
            case .email: return "Email not confirmed"
            case .account: return "Relay account needed"
            case .terms: return "Accept the terms"
            case .suspended: return "Suspended"
            case .updateApp: return "Update the app"
            case .updateCezar: return "Update cezar"
            case .quota: return "Relay limit reached"
            case .broken: return DeviceSwitch.cantConnect
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
        case .emailUnconfirmed: return .other(.email)
        case .accountRequired: return .other(.account)
        case .suspended: return .other(.suspended)
        case .termsRequiredDevice: return .other(.terms)
        case .deviceRemoved: return .other(.removed)
        case .updateApp: return .other(.updateApp)
        case .updateCezar: return .other(.updateCezar)
        case .quota: return .other(.quota)
        case .broken: return .other(.broken)
        }
    }

    /// A health answer, for a direct server.
    static func status(_ kind: HealthAnswer.Kind) -> Status {
        switch kind {
        case .cezar: return .online
        case .unreachable, .cezarOffline, .notAnswering, .relayDown: return .offline
        case .basicGate, .loginPage: return .other(.signIn)
        case .emailUnconfirmed: return .other(.email)
        case .accountRequired: return .other(.account)
        case .suspended: return .other(.suspended)
        case .termsRequiredDevice: return .other(.terms)
        case .deviceRemoved: return .other(.removed)
        case .updateApp: return .other(.updateApp)
        case .updateCezar: return .other(.updateCezar)
        case .quota: return .other(.quota)
        case .localMode, .tlsFailure, .notCezar: return .other(.broken)
        }
    }

    /// "Online", "Offline since 14:02" (a date when not today), "Checking…", or the status's own words.
    static func words(_ status: Status, seenAt: Int64?, now: Int64, calendar: Calendar = .current, locale: Locale = .current) -> String {
        switch status {
        case .online: return "Online"
        case .checking: return "Checking…"
        case .other(let reason): return reason.words
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
    /// `probedCurrent`: Your cezars, where the current page is no longer on screen, so its probe's answer counts.
    static func rows(_ servers: [ServerRecord], currentId: String?, readings: [String: Reading], book: DeviceBook, now: Int64,
                     probedCurrent: Bool = false, calendar: Calendar = .current, locale: Locale = .current) -> [Row] {
        let rows = servers.map { server -> Row in
            let current = server.id == currentId
            let reading = readings[server.id]
            // The page on screen is up, whatever its probe said; on the list, until a probe says otherwise.
            let answered = probedCurrent && reading.map { $0.status != .checking } == true
            let status = current && !answered ? .online : reading?.status ?? .checking
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
