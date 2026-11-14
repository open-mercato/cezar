import Foundation

/// The single relay connection and single listener a process may hold: only the server on screen has one (spec).
final class RelayConnections: ShellConnector.RelayPort {
    private static let SETTLE_MS: Int64 = 12000
    private static let GOODBYE_MS: Int64 = 8000
    /// Per server: the cockpit's bundle is a few MB, and an old build's files age out first.
    private static let BUNDLE_BYTES: Int64 = 40 * 1024 * 1024
    private static let PREWARM_MS = 20000

    private let transport: SocketTransport
    private let keys: DeviceKeyStore
    private let userAgent: String
    /// App-private, out of backups. Nil keeps every request in the tunnel.
    private let bundles: URL?
    /// Java's `synchronized`: `openProxy` calls `link` while holding it.
    private let lock = NSRecursiveLock()
    private var serverId: String?
    private var deviceId: String?
    private var currentLink: RelayLink?
    private var proxy: LoopbackProxy?

    init(transport: SocketTransport, keys: DeviceKeyStore, userAgent: String, bundles: URL? = nil) {
        self.transport = transport
        self.keys = keys
        self.userAgent = userAgent
        self.bundles = bundles
    }

    /// The server's cached cockpit bundle, or nil with no cache. Its id is a UUID the app made.
    func bundle(_ id: String?) -> BundleCache? {
        guard let bundles, let id, RelayRegex.matches("[A-Za-z0-9-]{1,64}", id) else { return nil }
        return BundleCache(directory: bundles.appendingPathComponent(id, isDirectory: true), maxBytes: Self.BUNDLE_BYTES)
    }

    /// The link for this server. Asking for another closes the first, listener included. Nil without keys.
    func link(_ server: ServerRecord) -> RelayLink? {
        lock.lock()
        defer { lock.unlock() }
        guard let relay = server.relay else { return nil }
        // Pairing the same cezar again keeps the row but changes the device, so the old link holds dead keys.
        if let currentLink, server.id == serverId, relay.deviceId == deviceId { return currentLink }
        release()
        guard let deviceKeys = keys.get(server.id), let pinned = Bytes.fromBase64url(relay.cezarKey, length: 32) else { return nil }
        let made = RelayLink(transport: transport, target: RelayLink.Target(socketOrigin: Self.socketOrigin(relay.origin), cezarId: relay.cezarId,
                                                                            deviceId: relay.deviceId, cezarStatic: pinned, keys: deviceKeys))
        currentLink = made
        serverId = server.id
        deviceId = relay.deviceId
        return made
    }

    private static func socketOrigin(_ origin: String) -> String {
        origin.hasPrefix("https") ? "wss" + origin.dropFirst(5) : "ws" + origin.dropFirst(4)
    }

    /// Opens the listener for the server on screen, on its saved port when that is free. Blocks briefly to bind.
    func openProxy(_ server: ServerRecord) throws -> LoopbackProxy {
        lock.lock()
        defer { lock.unlock() }
        guard let current = link(server) else { throw RelayIOError("no device keys") }
        proxy?.close()
        proxy = nil
        let next = LoopbackProxy(tunnel: { current.session() }, userAgent: userAgent, cache: bundle(server.id))
        _ = try next.open(preferredPort: server.relay?.port ?? 0)
        proxy = next
        return next
    }

    /// A start that will skip the probe: the relay connect and handshake run beside the app's own
    /// start-up. Stopped again if no server view takes the link within PREWARM_MS.
    func prewarm(_ server: ServerRecord) {
        guard let warm = link(server) else { return }
        warm.start()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(Self.PREWARM_MS)) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            if self.proxy == nil && self.currentLink === warm { warm.stop() }
        }
    }

    /// Whether this view's listener is still the process's one: a newer view may have taken the connection.
    func holds(_ opened: LoopbackProxy?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return opened != nil && opened === proxy
    }

    /// Called when a server view goes away. A newer view may hold the connection by then, and it stays.
    func release(_ opened: LoopbackProxy?) {
        lock.lock()
        defer { lock.unlock() }
        if opened === proxy { release() }
    }

    func release() {
        lock.lock()
        defer { lock.unlock() }
        proxy?.close()
        proxy = nil
        currentLink?.dispose()
        currentLink = nil
        serverId = nil
        deviceId = nil
    }

    func probe(_ server: ServerRecord) async -> HealthAnswer {
        guard let current = link(server) else { return HealthAnswer.of(.deviceRemoved, 0) }
        current.start()
        let status = await Self.offMain { current.awaitSettled(timeoutMs: Self.SETTLE_MS) }
        let answer: HealthAnswer
        if status.kind == .ready {
            answer = await HealthProbe(http: TunnelHttpGet(sessions: { current.session() }), userAgent: userAgent).probePath()
        } else {
            let kind = status.kind == .connecting && current.relayAnswered() ? "NOT_ANSWERING" : status.kind.rawValue
            answer = HealthAnswer.fromRelay(kind, minutes: Int((status.retryAfterSeconds + 59) / 60))
        }
        // Foreground only: nothing holds a socket behind a connect-page error screen.
        if answer.kind != .cezar { current.stop() }
        return answer
    }

    /// Blocks up to 8 s: never on the main thread.
    func goodbye(_ server: ServerRecord) {
        guard let current = link(server) else { return }
        current.start()
        if current.awaitSettled(timeoutMs: Self.GOODBYE_MS).kind == .ready { current.goodbye() }
        release()
    }

    func forgetKeys(_ id: String) {
        keys.delete(id)
    }

    func quickPath(_ server: ServerRecord) -> String? {
        guard let cache = bundle(server.id), cache.hasShell() else { return nil }
        return cache.startPath()
    }

    func opened(_ server: ServerRecord, path: String) {
        bundle(server.id)?.saveStartPath(path)
    }

    func forgetBundle(_ id: String) {
        bundle(id)?.clear()
    }

    private static func offMain<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: work()) }
        }
    }
}
