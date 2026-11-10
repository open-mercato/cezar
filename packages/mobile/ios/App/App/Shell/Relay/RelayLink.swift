import Foundation

/// One phone socket and the session on it (RELAY_PROTOCOL.md §§ 3, 4, 10). Every event runs on one
/// serial queue, so the state machine has no locks. Foreground only: `stop()` closes with 1000.
final class RelayLink {
    typealias Listener = (RelayStatus) -> Void

    /// What pairing pinned.
    struct Target {
        let socketOrigin: String
        let cezarId: String
        let deviceId: String
        let cezarStatic: [UInt8]
        let keys: DeviceKeys
    }

    static let FRAME_FLOOR = 16384
    static let FRAME_DEFAULT = 65552
    private static let PING_EVERY_MS: Int64 = 45000
    private static let PONG_WAIT_MS: Int64 = 15000
    private static let KK_WAIT_MS: Int64 = 10000
    private static let HELLO_WAIT_MS: Int64 = 15000
    private static let RESET_ATTEMPTS_AFTER_MS: Int64 = 60000
    private static let SILENT_KK_LIMIT = 3
    /// The AEAD tag: what sets a transport message's length class apart from a `KK` reply's (§ 10).
    private static let TRANSPORT_OVERHEAD = 16
    private static let PROLOGUE_LABEL = Bytes.ascii("cezar-session-v1")

    private let transport: SocketTransport
    private let target: Target
    private let clock: () -> Int64
    private let actor: RelayActor
    private let statusMonitor = NSCondition()
    private var currentStatus = RelayStatus(.idle)
    private let currentSession = Locked<TunnelSession?>(nil)
    private let listener = Locked<Listener?>(nil)
    private let answered = Locked(false)

    // Actor state.
    private var running = false
    private var epoch = 0
    private var socket: SocketConnection?
    private var handshake: NoiseHandshake?
    private var frameBytes = RelayLink.FRAME_DEFAULT
    private var framesPerSecond = TunnelSession.FRAMES_PER_SECOND_DEFAULT
    private var attempts = 0
    private var clockOffsetSeconds: Int64 = 0
    private var proofRetried = false
    private var closingRetryAfter: Int64 = -1
    private var connectedAt: Int64 = 0
    private var pongPending = false
    private var helloSeen = false
    private var silentHandshakes = 0

    init(transport: SocketTransport, target: Target, clock: @escaping () -> Int64 = relayNowMs) {
        self.transport = transport
        self.target = target
        self.clock = clock
        actor = RelayActor(label: "cezar-relay-link")
    }

    func setListener(_ value: Listener?) {
        listener.value = value
        value?(status())
    }

    func status() -> RelayStatus {
        statusMonitor.lock()
        defer { statusMonitor.unlock() }
        return currentStatus
    }

    func session() -> TunnelSession? { currentSession.value }

    /// A `hello` arrived, so a wait that ran out was not the relay's silence.
    func relayAnswered() -> Bool { answered.value }

    func start() {
        // Set here, not on the actor: a caller's awaitSettled must not read the old IDLE as an answer.
        if status().kind == .idle { setStatus(RelayStatus(.connecting)) }
        run { [self] in
            if running { return }
            running = true
            attempts = 0
            connect()
        }
    }

    func stop() {
        run { [self] in
            running = false
            dropSocket()
            setStatus(RelayStatus(.idle))
        }
    }

    /// A Retry button: skips the wait, and leaves any terminal state.
    func retryNow() {
        run { [self] in
            running = true
            attempts = 0
            proofRetried = false
            dropSocket()
            setStatus(RelayStatus(.connecting))
            connect()
        }
    }

    /// Stops for good. This link is never started again.
    func dispose() {
        stop()
        run { [actor] in actor.shutdown() }
    }

    /// Forget server: `CLOSE` `goodbye` if a session is live (§ 10.1), then the socket closes.
    func goodbye() {
        run { [self] in
            currentSession.value?.close(TunnelFrame.CLOSE_GOODBYE)
            running = false
            dropSocket()
            setStatus(RelayStatus(.idle))
        }
    }

    /// Blocks for the first answer after `start()`; `.connecting` means none came in time. Never on the main thread.
    func awaitSettled(timeoutMs: Int64) -> RelayStatus {
        let deadline = Date(timeIntervalSinceNow: Double(timeoutMs) / 1000)
        statusMonitor.lock()
        defer { statusMonitor.unlock() }
        while currentStatus.kind == .connecting {
            if !statusMonitor.wait(until: deadline) { break }
        }
        return currentStatus
    }

    private func setStatus(_ next: RelayStatus) {
        statusMonitor.lock()
        currentStatus = next
        statusMonitor.broadcast()
        statusMonitor.unlock()
        listener.value?(next)
    }

    private func connect() {
        if !running || socket != nil { return }
        epoch += 1
        let mine = epoch
        let time = clock() / 1000 + clockOffsetSeconds
        let headers = RelayIds.phoneHeaders(target.keys.ed25519Seed, cezarId: target.cezarId, deviceId: target.deviceId, time: time)
        let url = target.socketOrigin + "/v1/phone/" + target.cezarId + "/" + target.deviceId
        socket = transport.connect(url: url, headers: headers, events: Events(self, epoch: mine))
    }

    /// Weak, so a socket that outlives a dropped link keeps nothing alive.
    private final class Events: SocketEvents {
        private weak var link: RelayLink?
        private let epoch: Int

        init(_ link: RelayLink, epoch: Int) {
            self.link = link
            self.epoch = epoch
        }

        func opened() { link?.post(epoch) { $0.onOpen() } }
        func text(_ text: String) { link?.post(epoch) { $0.onText(text) } }
        func binary(_ bytes: [UInt8]) { link?.post(epoch) { $0.onBinary(bytes) } }
        func closed(_ code: Int) { link?.post(epoch) { $0.onClosed(code) } }
        func failed(status: Int, code: String?, retryAfterSeconds: Int64, dateMillis: Int64) {
            link?.post(epoch) { $0.onRefused(status, code, retryAfterSeconds, dateMillis) }
        }
    }

    /// Drops an event from a socket this link has already left.
    private func post(_ mine: Int, _ event: @escaping (RelayLink) -> Void) {
        run { [self] in
            if mine == epoch { event(self) }
        }
    }

    /// A caller can outlive the link: a probe holds it while the server view releases it. Disposed drops it.
    private func run(_ event: @escaping () -> Void) {
        actor.execute(event)
    }

    private func later(_ delayMs: Int64, _ event: @escaping (RelayLink) -> Void) {
        let mine = epoch
        actor.schedule(afterMs: delayMs) { [weak self] in
            guard let self, mine == self.epoch else { return }
            event(self)
        }
    }

    private func onOpen() {
        connectedAt = clock()
        closingRetryAfter = -1
        later(Self.HELLO_WAIT_MS) { link in
            if link.currentSession.value == nil && link.handshake == nil && !link.helloSeen { link.lost() }
        }
        later(Self.PING_EVERY_MS) { $0.ping() }
        later(Self.RESET_ATTEMPTS_AFTER_MS) { $0.attempts = 0 }
    }

    private func ping() {
        guard let socket else { return }
        socket.sendText("ping")
        pongPending = true
        later(Self.PONG_WAIT_MS) { link in
            if link.pongPending { link.lost() }
        }
        later(Self.PING_EVERY_MS) { $0.ping() }
    }

    private func onText(_ text: String) {
        if text == "pong" {
            pongPending = false
            return
        }
        guard let frame = RelayJson.object(text) else { return }
        switch RelayJson.string(frame, "t") {
        case "hello":
            onHello(frame)
        case "cezar-online":
            endSession()
            startHandshake()
        case "cezar-offline":
            endSession()
            setStatus(RelayStatus(.cezarOffline))
        case "closing":
            closingRetryAfter = min(RelayJson.int64(frame, "retryAfter", -1), maxRelayWaitSeconds)
        default:
            break // Unknown frames are ignored, so a later relay can add them (§ 4).
        }
    }

    private func onHello(_ hello: [String: Any]) {
        helloSeen = true
        answered.value = true
        proofRetried = false
        if RelayJson.int(hello, "protocol", 1) != 1 {
            stopWith(RelayStatus(.updateApp))
            return
        }
        let limits = hello["limits"] as? [String: Any]
        frameBytes = limits == nil ? Self.FRAME_DEFAULT : RelayJson.int(limits, "frameBytes", Self.FRAME_DEFAULT)
        if frameBytes < Self.FRAME_FLOOR {
            stopWith(RelayStatus(.broken))
            return
        }
        framesPerSecond = limits == nil ? TunnelSession.FRAMES_PER_SECOND_DEFAULT
            : RelayJson.int(limits, "framesPerSecond", TunnelSession.FRAMES_PER_SECOND_DEFAULT)
        // The key is absent on a 4430 hello, and `closing` follows (§ 4).
        let cezar = RelayJson.string(hello, "cezar")
        if cezar == "online" {
            startHandshake()
        } else if cezar == "offline" {
            setStatus(RelayStatus(.cezarOffline))
        }
    }

    private func stopWith(_ next: RelayStatus) {
        running = false
        dropSocket()
        setStatus(next)
    }

    private func startHandshake() {
        guard let cezarId = Bytes.fromBase64url(target.cezarId), let deviceId = Bytes.fromBase64url(target.deviceId), let socket else {
            stopWith(RelayStatus(.broken))
            return
        }
        let started = NoiseHandshake.kkInitiator(prologue: Self.PROLOGUE_LABEL + cezarId + deviceId, staticSecret: target.keys.x25519Secret,
                                                 remoteStatic: target.cezarStatic)
        handshake = started
        do {
            try Self.send(socket, started.writeMessage([]))
        } catch {
            lost()
            return
        }
        later(Self.KK_WAIT_MS) { link in
            if link.handshake === started { link.onSilentHandshake() }
        }
    }

    /// A relay that still admits a removed phone looks like this, so it must not stay invisible (§ 10.1).
    private func onSilentHandshake() {
        silentHandshakes += 1
        dropSocket()
        if silentHandshakes >= Self.SILENT_KK_LIMIT { setStatus(RelayStatus(.notAnswering)) }
        reconnect(jitterMs())
    }

    private static func send(_ connection: SocketConnection, _ ciphertext: [UInt8]) throws {
        if !connection.sendBinary([1] + ciphertext) { throw RelayIOError("socket refused the frame") }
    }

    private func onBinary(_ frame: [UInt8]) {
        guard let first = frame.first, first == 1 else {
            lost()
            return
        }
        let ciphertext = Array(frame.dropFirst())
        // A frame from an ended session can reach a new socket: the relay routes by deviceId (§ 10).
        if handshake != nil {
            if (ciphertext.count - Self.TRANSPORT_OVERHEAD) % TunnelRecord.unit != 0 { finishHandshake(ciphertext) }
        } else if let live = currentSession.value {
            live.receive(ciphertext)
        }
    }

    private func finishHandshake(_ reply: [UInt8]) {
        guard let current = handshake?.copy(), let connection = socket else { return }
        let payload: [UInt8]
        do {
            payload = try current.readMessage(reply)
        } catch {
            lost()
            return
        }
        handshake = nil
        silentHandshakes = 0
        do {
            guard let json = RelayJson.object(try TunnelRecord.unpad(payload)), let tunnel = json["tunnel"] as? [String: Any] else {
                throw RelayJson.Missing(key: "tunnel")
            }
            let cezarMin = try RelayJson.requiredInt(tunnel, "min")
            let cezarMax = try RelayJson.requiredInt(tunnel, "max")
            let next = TunnelSession(wire: { try RelayLink.send(connection, $0) }, keys: try current.split(), frameBytes: frameBytes,
                                     pacer: FramePacer(framesPerSecond: framesPerSecond, clock: clock),
                                     listener: { [weak self] code in self?.onSessionEnded(code) }, clock: clock)
            if min(TunnelSession.TUNNEL_MAX, cezarMax) < max(TunnelSession.TUNNEL_MIN, cezarMin) {
                next.close(TunnelFrame.CLOSE_TUNNEL_UNSUPPORTED)
                stopWith(RelayStatus(TunnelSession.TUNNEL_MAX < cezarMin ? .updateApp : .updateCezar))
                return
            }
            try next.start()
            currentSession.value = next
            later(TunnelSession.LEASE_EVERY_MS) { $0.leaseTick(next) }
            setStatus(RelayStatus(.ready))
        } catch {
            lost()
        }
    }

    private func leaseTick(_ current: TunnelSession) {
        if currentSession.value !== current { return }
        do {
            if current.leaseExpired() {
                lost()
                return
            }
            try current.lease()
        } catch {
            lost()
            return
        }
        later(TunnelSession.LEASE_EVERY_MS) { $0.leaseTick(current) }
    }

    /// On the actor, from `TunnelSession.receive`. `device-removed` waits for 4403, which the next connect gets.
    private func onSessionEnded(_ code: Int) {
        currentSession.value = nil
        lost()
    }

    private func endSession() {
        let current = currentSession.value
        currentSession.value = nil
        handshake = nil
        current?.end()
    }

    private func dropSocket() {
        epoch += 1
        endSession()
        helloSeen = false
        pongPending = false
        let current = socket
        socket = nil
        current?.close(1000)
    }

    /// Network loss, and anything treated like it: close with 1000 and reconnect with jitter.
    private func lost() {
        dropSocket()
        reconnect(jitterMs())
    }

    private func jitterMs() -> Int64 {
        let ceiling = Int64(1000) << Int64(min(attempts, 8))
        return 1000 + Int64(Double.random(in: 0..<1) * Double(min(300_000, ceiling) - 1000 + 1))
    }

    private func reconnect(_ delayMs: Int64) {
        if !running { return }
        attempts += 1
        let now = status().kind
        // A silent handshake is not the relay being down: it answered, cezar did not.
        let keep = now == .quota || now == .cezarOffline || now == .notAnswering || (now == .connecting && silentHandshakes > 0)
        if !keep { setStatus(RelayStatus(.relayDown)) }
        later(delayMs) { $0.connect() }
    }

    private func onClosed(_ code: Int) {
        epoch += 1
        socket = nil
        endSession()
        helloSeen = false
        pongPending = false
        switch code {
        case 4400, 4413:
            stopWith(RelayStatus(.broken))
        case 4401:
            refusedProof(-1)
        case 4403:
            stopWith(RelayStatus(.deviceRemoved))
        case 4409:
            // Replaced by a newer socket: this one just ends.
            running = false
            setStatus(RelayStatus(.idle))
        case 4426:
            stopWith(RelayStatus(.updateApp))
        case 4429:
            reconnect(closingRetryAfter > 0 ? relayWaitMs(closingRetryAfter) : jitterMs())
        case 4430:
            let seconds = closingRetryAfter > 0 ? closingRetryAfter : 300
            setStatus(RelayStatus(.quota, retryAfterSeconds: seconds))
            reconnect(relayWaitMs(seconds))
        case 4503:
            reconnect(killSwitchMs())
        default:
            reconnect(jitterMs())
        }
    }

    private func killSwitchMs() -> Int64 { 300_000 + Int64(Double.random(in: 0..<1) * 600_000) }

    private func onRefused(_ httpStatus: Int, _ code: String?, _ retryAfter: Int64, _ date: Int64) {
        epoch += 1
        socket = nil
        endSession()
        helloSeen = false
        switch httpStatus {
        case 401:
            refusedProof(date)
        case 403:
            stopWith(RelayStatus(.deviceRemoved))
        case 426:
            stopWith(RelayStatus(.updateApp))
        case 429:
            reconnect(retryAfter > 0 ? relayWaitMs(retryAfter) : jitterMs())
        case 503:
            reconnect(code == "relay-disabled" ? killSwitchMs() : retryAfter > 0 ? relayWaitMs(retryAfter) : jitterMs())
        case 400, 404, 405, 409:
            stopWith(RelayStatus(.broken))
        default:
            reconnect(jitterMs())
        }
    }

    /// Retry once, correcting the time by `Date`, then stop and report (§ 3.2).
    private func refusedProof(_ date: Int64) {
        if proofRetried {
            stopWith(RelayStatus(.broken))
            return
        }
        proofRetried = true
        if date > 0 { clockOffsetSeconds = (date - clock()) / 1000 }
        connect()
    }
}
