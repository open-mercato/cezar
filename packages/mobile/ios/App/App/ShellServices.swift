import Foundation

/// The User-Agent token and one of each service per process: the only thing a server page learns
/// about the shell is the token (spec Decision 2).
enum ShellServices {
    static func userAgentToken(version: String) -> String { "CezarMobile/\(version) (ios)" }

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    static var userAgent: String { userAgentToken(version: version) }

    #if DEBUG
    static let debugBuild = true
    #else
    static let debugBuild = false
    #endif

    /// Application Support/cezar, never in a backup.
    static let directory: URL = {
        var directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("cezar", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return directory
    }()

    static let deviceKeys: DeviceKeyStore = KeychainDeviceKeyStore()
    static let transport: SocketTransport = URLSessionTransport()
    static let relay = RelayConnections(transport: transport, keys: deviceKeys, userAgent: userAgent)

    static let push = PushCoordinator(store: PushStore(directory: PushStore.defaultDirectory()), tokens: ApnsTokenSource.shared,
                                      grants: GrantClient(relay: URLSessionPushRelay(), clock: nowMs),
                                      keys: PushCoordinator.StoreKeys(deviceKeys), clock: nowMs)

    static let connector = ShellConnector(servers: ServerListStore(directory: directory), credentials: KeychainCredentialStore(),
                                          probe: HealthProbe(http: PlatformHttpGet(), userAgent: userAgent),
                                          relay: relay, push: PushPort())

    static let notifier = PushNotifier(servers: { connector.list() })

    static let pairing = PairingFlow(transport: transport, phoneName: phoneName, debugBuild: debugBuild) { origin, state, keys in
        guard let cezarId = state.cezarId, let cezarStatic = state.cezarStatic else { throw RelayIOError("approval without keys") }
        let cezarKey = Bytes.base64url(cezarStatic)
        let id = connector.relayServerId(cezarId: cezarId, cezarKey: cezarKey)
        try deviceKeys.put(id, keys)
        _ = connector.saveRelayServer(id: id, label: state.label ?? "Computer",
                                      fields: RelayFields(origin: origin.origin, cezarId: cezarId, cezarKey: cezarKey, deviceId: keys.deviceId(), port: 0))
        lastPaired.value = id
    }

    /// The server the last approval saved.
    static let lastPaired = Locked<String?>(nil)

    /// The push route, asked inside the session that is up at the time.
    static func cezarPush(_ session: @escaping () -> TunnelSession?) -> CezarPush {
        let http = TunnelHttp(sessions: session)
        return CezarPush(http: { method, path, headers, body in
            let answer = try http.send(method: method, path: path, headers: headers, body: body)
            var flat: [String: String] = [:]
            for (name, values) in answer.headers { flat[name.lowercased()] = values.first }
            return HttpAnswer(status: answer.status, headers: flat, body: answer.body)
        }, userAgent: userAgent)
    }

    /// Stage 1's signal stream, opened inside whichever session is up at the time.
    static func signals(_ session: @escaping () -> TunnelSession?) -> SignalStream.Source {
        SignalSource(session: session, headers: ["Accept": "text/event-stream", "User-Agent": userAgent])
    }

    static func nowMs() -> Int64 { relayNowMs() }

    /// The generic model name only: the device's own name needs an entitlement and is personal data.
    private static var phoneName: String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return machine.hasPrefix("iPad") ? "iPad" : "iPhone"
    }

    /// Forget asks push first: a revoke still owed keeps the device key (§ 7).
    private final class PushPort: ShellConnector.PushPort {
        func forget(_ server: ServerRecord) -> Bool { ShellServices.push.forget(server) }
    }

    private struct SignalSource: SignalStream.Source {
        let session: () -> TunnelSession?
        let headers: [String: String]

        func open() throws -> SignalStream.Connection {
            Connection(stream: try TunnelGetStream.open(session: session(), path: SignalStream.path, headers: headers))
        }

        final class Connection: SignalStream.Connection {
            let stream: TunnelGetStream
            init(stream: TunnelGetStream) { self.stream = stream }
            var status: Int { stream.status() }
            func read(timeoutMs: Int64) throws -> [UInt8]? { try stream.read(timeoutMs: timeoutMs) }
            func close() { stream.close() }
        }
    }
}

/// One-shot message from the server view back to the connect page.
struct ShellRoute {
    let screen: String
    let serverId: String?

    private static let lock = NSLock()
    private static var pending: ShellRoute?

    static func set(_ route: ShellRoute) {
        lock.lock()
        defer { lock.unlock() }
        pending = route
    }

    static func take() -> ShellRoute? {
        lock.lock()
        defer { lock.unlock() }
        let route = pending
        pending = nil
        return route
    }
}
