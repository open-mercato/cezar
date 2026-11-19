import Foundation

/// One grant per relay server with its switch on: got on server open, handed to cezar, renewed, and
/// revoked at the relay when the switch goes off or the server is forgotten (spec R5 as built, § 7).
/// Logs statuses only, never a grant or a token. Blocking: call it off the main thread.
final class PushCoordinator {
    private static let maxJitterMs: Int64 = 300_000
    /// A store write failed (disk full, say): push degrades, the app never crashes on it.
    private static let unsaved = "push state: not saved"

    /// The device keys a server proves with. The relay client owns them; a revoke may outlive the server.
    protocol Keys {
        func get(_ serverId: String) -> DeviceKeys?
        func delete(_ serverId: String)
    }

    /// The Keychain store the relay client already keeps, as `Keys`.
    struct StoreKeys: Keys {
        let store: DeviceKeyStore

        init(_ store: DeviceKeyStore) { self.store = store }

        func get(_ serverId: String) -> DeviceKeys? { store.get(serverId) }
        func delete(_ serverId: String) { store.delete(serverId) }
    }

    private let store: PushStore
    private let tokens: TokenSource
    private let grants: GrantClient
    private let keys: Keys
    private let clock: () -> Int64
    private let random: () -> Double
    /// Java's `synchronized`: one sync, switch or forget at a time.
    private let lock = NSRecursiveLock()

    /// `clock`: milliseconds since the epoch. `random`: uniform in [0, 1).
    init(store: PushStore, tokens: TokenSource, grants: GrantClient, keys: Keys, clock: @escaping () -> Int64,
         random: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        self.store = store
        self.tokens = tokens
        self.grants = grants
        self.keys = keys
        self.clock = clock
        self.random = random
    }

    /// APNs, for Stage 2 (app closed or asleep). False in a build with no `aps-environment` entitlement: no
    /// grant and no request. The switch works either way, since Stage 1 needs only the session.
    func available() -> Bool { tokens.available() }

    func enabled(_ serverId: String) -> Bool { store.server(serverId).enabled }

    /// The first relay pairing asks once whether to turn notifications on, APNs or not.
    func shouldAsk() -> Bool { !store.asked() }

    func markAsked() {
        do { try store.setAsked() } catch { PushLog.info(Self.unsaved) }
    }

    /// The Servers list's switch, on any relay server. On is only saved: the signal stream and, with APNs,
    /// the grant come with the next session (`sync`). Off revokes at the relay at once, and leaves cezar
    /// its `DELETE` for the next session.
    @discardableResult
    func setEnabled(_ server: ServerRecord?, _ on: Bool) -> Bool {
        guard let server, server.relay != nil else { return false }
        return locked {
            do {
                let current = store.server(server.id)
                if on {
                    try store.putServer(server.id, PushStore.Server(enabled: true, held: current.held, grant: current.grant))
                    return true
                }
                // Owed before it is cleared: a crash between the two writes must not lose the grant.
                if let grant = current.grant { try queueRevoke(server, grant, forgotten: false) }
                try store.putServer(server.id, PushStore.Server(enabled: false, held: current.held, grant: nil))
                try settleRevokes()
                return true
            } catch {
                PushLog.info(Self.unsaved)
                return false
            }
        }
    }

    /// A session to this server is up. Settles owed revokes, then makes cezar hold this phone's current grant, or none.
    func sync(_ server: ServerRecord?, _ cezar: CezarPush) {
        guard let server, server.relay != nil else { return }
        locked {
            do {
                try settleRevokes()
                let current = store.server(server.id)
                if !current.enabled {
                    if current.held {
                        try cezar.delete()
                        try store.putServer(server.id, PushStore.Server(enabled: false, held: false, grant: nil))
                    }
                    return
                }
                if !available() { return }
                let state = try cezar.get()
                if !state.available {
                    try drop(server, current)
                    return
                }
                var grant = current.grant
                switch RenewalPolicy.decide(grant, state, nowSeconds: clock() / 1000, tokenChanged: store.renewOwed(server.id)) {
                case .none:
                    if let held = grant, !held.handedOver {
                        try store.putServer(server.id, PushStore.Server(enabled: true, held: true, grant: held.asHandedOver()))
                    }
                    return
                case .obtain:
                    guard let fresh = try obtain(server, state.cezarKey) else { return }
                    grant = fresh
                case .handOver:
                    break
                }
                if let grant { try handOver(server, cezar, grant) }
            } catch is PushStore.Unsaved {
                PushLog.info(Self.unsaved)
            } catch {
                PushLog.info("push sync: \(Self.describe(error))")
            }
        }
    }

    /// APNs gave a new token: each server with its switch on gets a grant for the new one, handed over on its next open.
    func onNewToken(_ servers: [ServerRecord]) {
        if !available() { return }
        locked {
            do {
                for server in servers where server.relay != nil {
                    let current = store.server(server.id)
                    // With no grant yet, cezar's key is unknown until the next open, which gets one anyway.
                    guard current.enabled, let grant = current.grant else { continue }
                    // Marked first: if this grant fails, the next open must not keep the one for the dead token.
                    try store.setRenew(server.id, true)
                    _ = try obtain(server, grant.cezarKey)
                }
            } catch {
                PushLog.info(Self.unsaved)
            }
        }
    }

    /// Forget server. The goodbye already made cezar deny its grants; the relay is told too. True while a
    /// revoke is owed, when the caller must keep the device key: the revoke is signed with it.
    func forget(_ server: ServerRecord?) -> Bool {
        guard let server else { return false }
        return locked {
            do {
                let current = store.server(server.id)
                if server.relay != nil, let grant = current.grant { try queueRevoke(server, grant, forgotten: true) }
                try store.removeServer(server.id)
                // A revoke the switch already owed now holds the device key too.
                try store.setRevokes(store.revokes().map { $0.serverId == server.id ? $0.markedForgotten() : $0 })
                try settleRevokes()
                return owes(server.id)
            } catch {
                PushLog.info(Self.unsaved)
                // Unsure what is owed: keep the device key, which a revoke would be signed with.
                return true
            }
        }
    }

    /// Servers forgotten with a revoke still owed (§ 7). Unlocked: the list must not wait on a sync's network.
    func removing() -> [String] {
        var labels: [String] = []
        for revoke in store.revokes() where revoke.forgotten && !labels.contains(revoke.label) { labels.append(revoke.label) }
        return labels
    }

    /// On app open and server open: each owed revoke that is due, until a terminal answer or its grant expires.
    func retryRevokes() {
        locked {
            do { try settleRevokes() } catch { PushLog.info(Self.unsaved) }
        }
    }

    private func settleRevokes() throws {
        let now = clock()
        var left: [PushStore.Revoke] = []
        var settled: [String] = []
        for revoke in store.revokes() {
            if revoke.expiresAt <= now / 1000 {
                settled.append(revoke.serverId)
                continue
            }
            if revoke.notBefore > now {
                left.append(revoke)
                continue
            }
            guard let deviceKeys = keys.get(revoke.serverId) else {
                // Nothing can sign it any more, so nothing more can be done.
                settled.append(revoke.serverId)
                continue
            }
            let answer = grants.revoke(origin: revoke.origin, keys: deviceKeys, grant: revoke.grant)
            if answer.outcome == .retry {
                left.append(revoke.retryAt(now + delayMs(answer.retryAfter, revoke.attempts)))
            } else {
                if answer.outcome == .stopped { PushLog.info("push revoke stopped: \(answer.status)") }
                settled.append(revoke.serverId)
            }
        }
        try store.setRevokes(left)
        for serverId in settled where !owes(serverId) && forgottenServer(serverId) { keys.delete(serverId) }
    }

    private func owes(_ serverId: String) -> Bool { store.revokes().contains { $0.serverId == serverId } }

    /// A forgotten server has no push row left; one with its switch off keeps its row.
    private func forgottenServer(_ serverId: String) -> Bool { !store.serverIds().contains(serverId) }

    /// `Retry-After` when the relay sent one, else full jitter: 1 s to min(300 s, 2^n s) (§ 3.3).
    private func delayMs(_ retryAfter: Int64, _ attempts: Int) -> Int64 {
        if retryAfter >= 0 { return max(1000, min(retryAfter, 86_400) * 1000) }
        let cap = min(Self.maxJitterMs, Int64(1000) << Int64(min(attempts + 1, 20)))
        return 1000 + Int64(random() * Double(cap - 1000))
    }

    private func obtain(_ server: ServerRecord, _ cezarKey: String?) throws -> PushGrant? {
        guard let relay = server.relay, let deviceKeys = keys.get(server.id) else { return nil }
        let token: String
        do {
            token = try tokens.token()
        } catch {
            PushLog.info("push token: unavailable")
            return nil
        }
        do {
            let grant = try grants.obtain(origin: relay.origin, keys: deviceKeys, token: token, cezarKey: cezarKey)
            let current = store.server(server.id)
            // The grant it replaces may still be cezar's if the hand-over fails, and nothing would
            // revoke it later: deny it now. cezar then gets 403 for it and drops it (§ 7). Queued
            // before the new grant is saved, so a crash between the writes cannot lose it.
            let replaced = current.grant.map { $0.grant != grant.grant } ?? false
            if replaced, let old = current.grant { try queueRevoke(server, old, forgotten: false) }
            try store.putServer(server.id, PushStore.Server(enabled: current.enabled, held: current.held, grant: grant))
            try store.setRenew(server.id, false)
            if replaced { try settleRevokes() }
            return grant
        } catch let failure as GrantClient.Failure {
            PushLog.info("push grant: \(failure.message)")
            return nil
        }
    }

    private func handOver(_ server: ServerRecord, _ cezar: CezarPush, _ grant: PushGrant) throws {
        let answer = try cezar.put(grant)
        let current = store.server(server.id)
        guard answer != nil else {
            try drop(server, current)
            return
        }
        try store.putServer(server.id, PushStore.Server(enabled: current.enabled, held: true, grant: grant.asHandedOver()))
    }

    /// cezar has push off: the phone keeps no grant for it, and the relay denies the one it had.
    private func drop(_ server: ServerRecord, _ current: PushStore.Server) throws {
        if let grant = current.grant { try queueRevoke(server, grant, forgotten: false) }
        try store.putServer(server.id, PushStore.Server(enabled: current.enabled, held: false, grant: nil))
        if current.grant != nil { try settleRevokes() }
    }

    private func queueRevoke(_ server: ServerRecord, _ grant: PushGrant, forgotten: Bool) throws {
        guard let relay = server.relay else { return }
        var revokes = store.revokes()
        revokes.append(PushStore.Revoke(serverId: server.id, label: server.label, origin: relay.origin, grant: grant.grant,
                                        expiresAt: grant.expiresAt, notBefore: 0, attempts: 0, forgotten: forgotten))
        try store.setRevokes(revokes)
    }

    /// A failure's own words only when it is one of ours: a transport error may quote the request.
    private static func describe(_ error: Error) -> String {
        if let failure = error as? CezarPush.Failure { return failure.message }
        return "no session"
    }

    private func locked<T>(_ work: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return work()
    }
}
