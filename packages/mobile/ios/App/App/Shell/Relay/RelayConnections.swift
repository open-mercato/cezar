import Foundation

/// The single relay connection and single listener a process may hold: only the server on screen has one (spec).
final class RelayConnections: ShellConnector.RelayPort {
    private static let SETTLE_MS: Int64 = 12000
    private static let GOODBYE_MS: Int64 = 8000

    private let transport: SocketTransport
    private let keys: DeviceKeyStore
    private let userAgent: String
    /// Java's `synchronized`: `openProxy` calls `link` while holding it.
    private let lock = NSRecursiveLock()
    private var serverId: String?
    private var deviceId: String?
    private var currentLink: RelayLink?
    private var proxy: LoopbackProxy?

    init(transport: SocketTransport, keys: DeviceKeyStore, userAgent: String) {
        self.transport = transport
        self.keys = keys
        self.userAgent = userAgent
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
        let next = LoopbackProxy(tunnel: { current.session() }, userAgent: userAgent)
        _ = try next.open(preferredPort: server.relay?.port ?? 0)
        proxy = next
        return next
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

    private static func offMain<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: work()) }
        }
    }
}
