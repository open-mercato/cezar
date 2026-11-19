import Foundation

/// A tapped relay notification carries only `s`, the cezarId (§ 7), and the manager comes from cezar
/// inside the session. A local one (Stage 1) may also carry `m`, the manager its signal named.
enum PushTap {
    static let extra = "s"
    /// Never sent by the relay: the app's own notification sets it, and it is checked like any other input.
    static let extraManager = "m"

    /// What PushTap needs of ShellConnector: the list and the normal open. A protocol so tests need no relay.
    protocol Connector {
        func list() -> [ServerRecord]
        func open(_ id: String, cookies: String?) async -> ShellConnector.Outcome
    }

    /// cezar's answer to `GET /workspace/phone/push` inside the session the open just made, or nil.
    typealias ManagerLookup = (ServerRecord) async -> String?

    /// What a tap asked for. `managerId` is nil, or valid.
    struct Tap: Equatable {
        let cezarId: String
        let managerId: String?
    }

    private static let lock = NSLock()
    private static var pending: Tap?

    /// A tap's `s` and `m`, kept for the connect page's next launch. Anything malformed is dropped.
    static func offer(_ cezarId: String?, _ managerId: String? = nil) {
        guard let cezarId, validCezarId(cezarId) else { return }
        lock.lock()
        pending = Tap(cezarId: cezarId, managerId: validManagerId(managerId) ? managerId : nil)
        lock.unlock()
    }

    static func take() -> Tap? {
        lock.lock()
        defer { lock.unlock() }
        let value = pending
        pending = nil
        return value
    }

    /// The saved relay server for this cezarId, or nil: an unknown one gets the normal start.
    static func serverFor(_ cezarId: String?, _ servers: [ServerRecord]) -> ServerRecord? {
        guard let cezarId, validCezarId(cezarId) else { return nil }
        return servers.first { $0.relay?.cezarId == cezarId }
    }

    /// Opens the tapped server through the normal open, so the app lock and the start table still apply.
    /// Nil for an unknown cezarId: the caller starts as usual. Nothing is ever approved from here.
    static func open(_ connector: Connector, _ cezarId: String, lookup: ManagerLookup) async -> ShellConnector.Outcome? {
        await open(connector, Tap(cezarId: cezarId, managerId: nil), lookup: lookup)
    }

    /// A tap's own manager wins: it is the signal's, and asking cezar costs a request.
    static func open(_ connector: Connector, _ tap: Tap, lookup: ManagerLookup) async -> ShellConnector.Outcome? {
        guard let server = serverFor(tap.cezarId, connector.list()) else { return nil }
        let outcome = await connector.open(server.id, cookies: nil)
        guard outcome.screen == ShellConnector.open, let url = outcome.url, let prefix = managerStart(url) else { return outcome }
        let managerId: String?
        if validManagerId(tap.managerId) {
            managerId = tap.managerId
        } else {
            managerId = await lookup(server)
        }
        return ShellConnector.withUrl(outcome, prefix + landing("/manager", managerId))
    }

    static func validManagerId(_ managerId: String?) -> Bool {
        guard let managerId else { return false }
        return (1...64).contains(managerId.utf8.count) && managerId.utf8.allSatisfy(isIdByte)
    }

    static func validCezarId(_ cezarId: String) -> Bool {
        cezarId.utf8.count == 22 && cezarId.utf8.allSatisfy(isIdByte)
    }

    /// Where the server view lands: the manager the push was about, when the start route is the manager at all.
    static func landing(_ startPath: String, _ managerId: String?) -> String {
        guard startPath == "/manager", let managerId, validManagerId(managerId) else { return startPath }
        // `[A-Za-z0-9_-]` needs no percent-encoding.
        return "/manager/" + managerId
    }

    /// `[A-Za-z0-9_-]`, the base64url alphabet.
    static func isIdByte(_ byte: UInt8) -> Bool {
        (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39) || byte == 0x2D || byte == 0x5F
    }

    /// The iOS outcome's url is the whole URL: what stands before a bare `/manager` start, or nil for any other start.
    private static func managerStart(_ url: String) -> String? {
        guard url.hasSuffix("/manager") else { return nil }
        let prefix = String(url.dropLast("/manager".count))
        if prefix.isEmpty { return prefix }
        guard let parsed = URL(string: prefix), parsed.scheme != nil, parsed.host != nil, parsed.path.isEmpty,
              parsed.query == nil, parsed.fragment == nil else { return nil }
        return prefix
    }
}
