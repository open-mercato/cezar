import Foundation

/// Add, open and forget: the connect flows, with no webview and no framework in sight.
final class ShellConnector {
    /// What the connect page or the server view does next.
    struct Outcome {
        let screen: String
        var serverId: String?
        /// Load this in the server view, when not nil.
        var url: String?
        var origin: ServerOrigin?
        var note: String?
        var status = 0
        /// On `login`: the id the server will be saved under, so the sign-in lands in its own data store.
        var pendingId: String?
    }

    static let open = "open"
    static let login = "login"
    static let list = "list"
    static let askCredentials = "ask-credentials"
    static let passwordRejected = "password-rejected"
    static let localMode = "local-mode"
    static let tlsFailure = "tls-failure"
    static let notCezar = "not-cezar"
    static let connectionError = "connection-error"
    static let cleartext = "cleartext-refused"
    static let invalidUrl = "invalid-url"
    static let cezarOffline = "cezar-offline"
    static let notAnswering = "cezar-not-answering"
    static let relayDown = "relay-down"
    static let quota = "quota"
    static let deviceRemoved = "device-removed"
    static let updateApp = "update-app"
    static let updateCezar = "update-cezar"

    /// The tunnel side of a relay server. Nil on a shell with no relay, which then behaves as before.
    protocol RelayPort: AnyObject {
        func probe(_ server: ServerRecord) async -> HealthAnswer
        /// Blocks up to seconds; called off the main thread.
        func goodbye(_ server: ServerRecord)
        func forgetKeys(_ id: String)
        /// A start path when the bundle is on the phone, so a start can skip the probe and paint at once.
        func quickPath(_ server: ServerRecord) -> String?
        /// A probed open landed on `path`.
        func opened(_ server: ServerRecord, path: String)
        /// Forget and Remove: the cached bundle goes with the server.
        func forgetBundle(_ id: String)
    }

    /// Push for relay servers. Forget asks it first: a revoke still owed at the relay keeps the device key (§ 7).
    protocol PushPort: AnyObject {
        /// Called off the main thread, after `RelayPort.goodbye`. True when push keeps the key for a revoke it still owes.
        func forget(_ server: ServerRecord) -> Bool
    }

    private let servers: ServerListStore
    private let credentials: CredentialStore
    private let probe: HealthProbe
    private let relay: RelayPort?
    private let push: PushPort?
    private let teardown = DispatchQueue(label: "cezar-forget")

    init(servers: ServerListStore, credentials: CredentialStore, probe: HealthProbe, relay: RelayPort? = nil, push: PushPort? = nil) {
        self.servers = servers
        self.credentials = credentials
        self.probe = probe
        self.relay = relay
        self.push = push
    }

    func list() -> [ServerRecord] { servers.list() }
    func server(_ id: String) -> ServerRecord? { servers.get(id) }
    func password(_ id: String) -> String? { credentials.get(id) }
    func lastUsedId() -> String? { servers.lastUsedId() }

    /// Cold launch: the last server used, else the list.
    func launch(cookiesForLast: String?) async -> Outcome {
        guard let last = servers.lastUsedId(), servers.get(last) != nil else { return Outcome(screen: Self.list) }
        return await open(last, cookies: cookiesForLast, quick: true)
    }

    func open(_ id: String, cookies: String?) async -> Outcome {
        await open(id, cookies: cookies, quick: false)
    }

    /// `quick`: a relay server whose bundle is cached opens without the probe; its view reports the link itself.
    func open(_ id: String, cookies: String?, quick: Bool) async -> Outcome {
        guard let server = servers.get(id) else { return Outcome(screen: Self.list) }
        if server.relay != nil { return await openRelay(server, quick: quick) }
        guard let origin = server.origin else { return Outcome(screen: Self.list) }
        if await realmChanged(server, origin, cookies: cookies) {
            return Outcome(screen: Self.askCredentials, serverId: id, status: 401)
        }
        let password = credentials.get(id)
        let health = await probe.probe(origin, username: server.username, password: password, cookies: cookies)
        let route = StartDecision.decide(health, passwordSaved: password != nil)
        switch route {
        case .askCredentials: return Outcome(screen: Self.askCredentials, serverId: id, status: health.status)
        case .passwordRejected: return Outcome(screen: Self.passwordRejected, serverId: id, status: health.status)
        case .localMode: return Outcome(screen: Self.localMode, serverId: id, status: health.status)
        case .connectionError:
            return Outcome(screen: health.kind == .tlsFailure ? Self.tlsFailure : Self.connectionError, serverId: id, status: health.status)
        default:
            servers.markUsed(id)
            return Outcome(screen: Self.open, serverId: id, url: origin.url(StartDecision.path(route)), origin: origin,
                           note: oneTimeNote(server, route, health), status: health.status)
        }
    }

    /// The start table for a relay server. Basic routes cannot occur: it has no challenge. `url` is a
    /// path here, and `origin` nil: the server view puts it under its `ProxyOrigin`.
    private func openRelay(_ server: ServerRecord, quick: Bool) async -> Outcome {
        guard let relay else { return Outcome(screen: Self.connectionError, serverId: server.id) }
        if quick, let cached = relay.quickPath(server) {
            servers.markUsed(server.id)
            return Outcome(screen: Self.open, serverId: server.id, url: cached)
        }
        let health = await relay.probe(server)
        let route = StartDecision.decide(health, passwordSaved: false)
        switch route {
        case .cezarOffline:
            return Outcome(screen: health.kind == .notAnswering ? Self.notAnswering : Self.cezarOffline, serverId: server.id)
        case .relayDown:
            return Outcome(screen: health.kind == .quota ? Self.quota : Self.relayDown, serverId: server.id, status: health.status)
        case .deviceRemoved:
            relay.forgetBundle(server.id)
            return Outcome(screen: Self.deviceRemoved, serverId: server.id)
        case .protocolMismatch:
            return Outcome(screen: health.kind == .updateApp ? Self.updateApp : Self.updateCezar, serverId: server.id)
        case .manager, .rootManagersOff, .rootOldServer:
            servers.markUsed(server.id)
            relay.opened(server, path: StartDecision.path(route))
            return Outcome(screen: Self.open, serverId: server.id, url: StartDecision.path(route), note: oneTimeNote(server, route, health),
                           status: health.status)
        default:
            return Outcome(screen: Self.connectionError, serverId: server.id, status: health.status)
        }
    }

    /// The row pairing saves into, known before it is saved: the keys go first. Reused only for the same
    /// pinned key: nothing binds `cezarId` to it, so an id alone could take over a saved server's port, and
    /// with it that origin's storage.
    func relayServerId(cezarId: String, cezarKey: String) -> String {
        servers.findPaired(cezarId: cezarId, cezarKey: cezarKey)?.id ?? UUID().uuidString
    }

    /// Pairing succeeded: the new keys replace any old ones under this row.
    @discardableResult
    func saveRelayServer(id: String, label: String, fields: RelayFields) -> String {
        let existing = servers.get(id)
        let port = existing?.relay?.port ?? 0
        servers.put(ServerRecord(id: id, label: label, url: nil, noteShown: existing?.noteShown, relay: fields.withPort(port)))
        servers.markUsed(id)
        return id
    }

    func saveRelayPort(id: String, port: Int) {
        guard let server = servers.get(id), server.relay != nil else { return }
        servers.put(server.withPort(port))
    }

    /// Runs the add-server table. A retried answer goes back through it, so 403 after 401 explains.
    func add(url: String?, username: String?, password: String?, label: String?) async -> Outcome {
        let origin: ServerOrigin
        do {
            origin = try ServerOrigin.parse(url)
        } catch ServerOrigin.Problem.cleartext {
            return Outcome(screen: Self.cleartext)
        } catch {
            return Outcome(screen: Self.invalidUrl)
        }
        let first = await probe.probe(origin, username: nil, password: nil, cookies: nil)
        guard first.kind == .basicGate else {
            return afterAnswer(first, origin, username: nil, password: nil, realm: nil, label: label)
        }
        guard let password, !password.isEmpty else { return Outcome(screen: Self.askCredentials, status: first.status) }
        let retried = await probe.probe(origin, username: username, password: password, cookies: nil)
        return afterAnswer(retried, origin, username: username, password: password, realm: first.realm, label: label)
    }

    /// The webview finished a page during an SSO add. Saves once health reads as cezar with its cookies.
    func confirmLogin(url: String, pendingId: String, cookies: String?, label: String?) async -> Outcome {
        guard let origin = try? ServerOrigin.parse(url) else { return Outcome(screen: Self.invalidUrl) }
        let health = await probe.probe(origin, username: nil, password: nil, cookies: cookies)
        guard health.kind == .cezar else { return Outcome(screen: Self.login, status: health.status, pendingId: pendingId) }
        return save(origin, username: nil, password: nil, realm: nil, label: label, health: health, id: pendingId)
    }

    /// Deletes the password first: a list that outlives it can only re-ask. A relay server's bundle goes next; its goodbye
    /// blocks for seconds, so it runs after, off this thread, in the order Android keeps: goodbye, then
    /// push, then the device key. `relayDone` runs once that is over.
    func forget(_ id: String, relayDone: (() -> Void)? = nil) {
        let server = servers.get(id)
        credentials.delete(id)
        servers.remove(id)
        guard let server, server.relay != nil, let relay else {
            relayDone?()
            return
        }
        relay.forgetBundle(id)
        let push = self.push
        teardown.async {
            relay.goodbye(server)
            if push == nil || push?.forget(server) == false { relay.forgetKeys(id) }
            relayDone?()
        }
    }

    /// Before the password goes out: a new realm gets no answer, and would strand a 401 page (BACKWARD_COMPATIBILITY.md §6b).
    private func realmChanged(_ server: ServerRecord, _ origin: ServerOrigin, cookies: String?) async -> Bool {
        guard let realm = server.realm else { return false }
        let bare = await probe.probe(origin, username: nil, password: nil, cookies: cookies)
        return bare.kind == .basicGate && bare.realm != realm
    }

    private func afterAnswer(_ health: HealthAnswer, _ origin: ServerOrigin, username: String?, password: String?, realm: String?, label: String?) -> Outcome {
        switch health.kind {
        case .cezar: return save(origin, username: username, password: password, realm: realm, label: label, health: health)
        case .basicGate: return Outcome(screen: Self.passwordRejected, status: health.status)
        case .localMode: return Outcome(screen: Self.localMode, status: health.status)
        case .loginPage:
            let pendingId = servers.find(url: origin.origin)?.id ?? UUID().uuidString
            return Outcome(screen: Self.login, url: origin.url("/"), origin: origin, status: health.status, pendingId: pendingId)
        case .tlsFailure: return Outcome(screen: Self.tlsFailure)
        case .unreachable: return Outcome(screen: Self.connectionError)
        case .notCezar: return Outcome(screen: Self.notCezar, status: health.status)
        case .cezarOffline, .notAnswering, .relayDown, .quota, .deviceRemoved, .updateApp, .updateCezar:
            return Outcome(screen: Self.connectionError, status: health.status)
        }
    }

    private func save(_ origin: ServerOrigin, username: String?, password: String?, realm: String?, label: String?, health: HealthAnswer,
                      id pendingId: String? = nil) -> Outcome {
        let existing = servers.find(url: origin.origin)
        let id = existing?.id ?? pendingId ?? UUID().uuidString
        let trimmed = label?.trimmingCharacters(in: .whitespaces) ?? ""
        if let password { credentials.put(id, password: password) } else { credentials.delete(id) }
        let server = ServerRecord(id: id, label: trimmed.isEmpty ? origin.host : trimmed, url: origin.origin,
                                  username: username, realm: realm, noteShown: existing?.noteShown)
        servers.put(server)
        servers.markUsed(id)
        let route = StartDecision.decide(health, passwordSaved: password != nil)
        return Outcome(screen: Self.open, serverId: id, url: origin.url(StartDecision.path(route)), origin: origin,
                       note: oneTimeNote(server, route, health), status: health.status)
    }

    private func oneTimeNote(_ server: ServerRecord, _ route: StartDecision.Route, _ health: HealthAnswer) -> String? {
        let note: String
        switch route {
        case .rootManagersOff: note = "Manager is turned off on this server."
        case .rootOldServer: note = "This server runs cezar \(health.version ?? "of an older version"), which has no Manager. Update it with cezar server-deploy."
        default: return nil
        }
        if server.noteShown == note { return nil }
        var updated = server
        updated.noteShown = note
        servers.put(updated)
        return note
    }
}

/// No bundle cache: every start probes, as before it.
extension ShellConnector.RelayPort {
    func quickPath(_ server: ServerRecord) -> String? { nil }
    func opened(_ server: ServerRecord, path: String) {}
    func forgetBundle(_ id: String) {}
}
