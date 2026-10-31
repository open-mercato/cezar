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

    private let servers: ServerListStore
    private let credentials: CredentialStore
    private let probe: HealthProbe

    init(servers: ServerListStore, credentials: CredentialStore, probe: HealthProbe) {
        self.servers = servers
        self.credentials = credentials
        self.probe = probe
    }

    func list() -> [ServerRecord] { servers.list() }
    func server(_ id: String) -> ServerRecord? { servers.get(id) }
    func password(_ id: String) -> String? { credentials.get(id) }
    func lastUsedId() -> String? { servers.lastUsedId() }

    /// Cold launch: the last server used, else the list.
    func launch(cookiesForLast: String?) async -> Outcome {
        guard let last = servers.lastUsedId(), servers.get(last) != nil else { return Outcome(screen: Self.list) }
        return await open(last, cookies: cookiesForLast)
    }

    func open(_ id: String, cookies: String?) async -> Outcome {
        guard let server = servers.get(id), let origin = server.origin else { return Outcome(screen: Self.list) }
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
            if await realmChanged(server, origin, cookies: cookies) {
                return Outcome(screen: Self.askCredentials, serverId: id, status: health.status)
            }
            servers.markUsed(id)
            return Outcome(screen: Self.open, serverId: id, url: origin.url(StartDecision.path(route)), origin: origin,
                           note: oneTimeNote(server, route, health), status: health.status)
        }
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
    func confirmLogin(url: String, cookies: String?, label: String?) async -> Outcome {
        guard let origin = try? ServerOrigin.parse(url) else { return Outcome(screen: Self.invalidUrl) }
        let health = await probe.probe(origin, username: nil, password: nil, cookies: cookies)
        guard health.kind == .cezar else { return Outcome(screen: Self.login, status: health.status) }
        return save(origin, username: nil, password: nil, realm: nil, label: label, health: health)
    }

    /// Deletes the password first: a list that outlives it can only re-ask.
    func forget(_ id: String) {
        credentials.delete(id)
        servers.remove(id)
    }

    /// The responder would refuse a new realm and strand a 401 page (BACKWARD_COMPATIBILITY.md §6b).
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
        case .loginPage: return Outcome(screen: Self.login, url: origin.url("/"), origin: origin, status: health.status)
        case .tlsFailure: return Outcome(screen: Self.tlsFailure)
        case .unreachable: return Outcome(screen: Self.connectionError)
        case .notCezar: return Outcome(screen: Self.notCezar, status: health.status)
        }
    }

    private func save(_ origin: ServerOrigin, username: String?, password: String?, realm: String?, label: String?, health: HealthAnswer) -> Outcome {
        let existing = servers.find(url: origin.origin)
        let id = existing?.id ?? UUID().uuidString
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
