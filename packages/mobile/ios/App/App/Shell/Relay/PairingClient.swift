import Foundation

/// The phone's side of one rendezvous (RELAY_PROTOCOL.md §§ 5, 9). One serial queue, and never reconnected.
final class PairingClient {
    enum Phase: String { case connecting = "CONNECTING", confirm = "CONFIRM", approved = "APPROVED", failed = "FAILED" }

    /// A snapshot for the connect page. `reason` is set on `.failed`; see screens.js.
    struct State {
        let phase: Phase
        let digits: String?
        let label: String?
        let reason: String?
        let cezarId: String?
        let cezarStatic: [UInt8]?
    }

    typealias Updates = (State) -> Void

    private static let XX_DEADLINE_MS: Int64 = 30000
    private static let OUTCOME_DEADLINE_MS: Int64 = 300_000
    private static let PING_EVERY_MS: Int64 = 45000
    private static let MAX_NAME_BYTES = 64
    private static let MAX_MESSAGE_BYTES = 1024
    private static let PROLOGUE_LABEL = Bytes.ascii("cezar-pair-v1")
    private static let knownFailures: Set<String> = ["device-limit", "relay-error", "timeout", "cancelled", "contested", "bad-payload"]

    private let transport: SocketTransport
    private let secret: PairSecret
    private let keys: DeviceKeys
    private let name: String
    private let updates: Updates
    private let outcomeDeadlineMs: Int64
    private let actor = RelayActor(label: "cezar-relay-pair")
    private var socket: SocketConnection?
    private var handshake: NoiseHandshake?
    private var transportKeys: NoiseHandshake.Keys?
    private var digits: String?
    private var label: String?
    private var cezarId: String?
    private var cezarStatic: [UInt8]?
    private var hello = false
    private var finished = false

    init(transport: SocketTransport, secret: PairSecret, keys: DeviceKeys, phoneName: String?, updates: @escaping Updates,
         outcomeDeadlineMs: Int64 = PairingClient.OUTCOME_DEADLINE_MS) {
        self.transport = transport
        self.secret = secret
        self.keys = keys
        name = Self.safeName(phoneName)
        self.updates = updates
        self.outcomeDeadlineMs = outcomeDeadlineMs
    }

    /// No control characters, and cut on a character boundary at 64 UTF-8 bytes (§ 9.3).
    static func safeName(_ raw: String?) -> String {
        var out = ""
        var bytes = 0
        for scalar in (raw ?? "").unicodeScalars {
            if scalar.value < 0x20 || (scalar.value >= 0x7f && scalar.value <= 0x9f) { continue }
            let size = String(scalar).utf8.count
            if bytes + size > MAX_NAME_BYTES { break }
            bytes += size
            out.unicodeScalars.append(scalar)
        }
        return out.isEmpty ? "iPhone" : out
    }

    func start() {
        actor.execute { [self] in
            updates(state(.connecting, nil))
            let url = secret.relay.socketOrigin + "/v1/pair/" + secret.locator + "?role=phone"
            socket = transport.connect(url: url, headers: [], events: Events(self))
            actor.schedule(afterMs: Self.PING_EVERY_MS) { [weak self] in self?.ping() }
        }
    }

    func cancel() {
        post { $0.finish(.failed, "cancelled") }
    }

    /// The socket calls back from its own threads; every event comes here. It holds the client, as
    /// Java's actor thread does, until the socket lets go of it.
    private final class Events: SocketEvents {
        private let client: PairingClient

        init(_ client: PairingClient) { self.client = client }

        // Nothing is sent until hello and peer-joined.
        func opened() {}
        func text(_ text: String) { client.post { $0.onText(text) } }
        func binary(_ bytes: [UInt8]) { client.post { $0.onBinary(bytes) } }
        func closed(_ code: Int) { client.post { $0.onClosed(code) } }
        func failed(status: Int, code: String?, retryAfterSeconds: Int64, dateMillis: Int64) { client.post { $0.onRefused(status) } }
    }

    /// The socket's last callback lands after `finish`, when the actor is already gone.
    private func post(_ event: @escaping (PairingClient) -> Void) {
        actor.execute { [self] in
            if !finished { event(self) }
        }
    }

    private func ping() {
        guard !finished, let socket else { return }
        socket.sendText("ping")
        actor.schedule(afterMs: Self.PING_EVERY_MS) { [weak self] in self?.ping() }
    }

    private func state(_ phase: Phase, _ reason: String?) -> State {
        State(phase: phase, digits: digits, label: label, reason: reason, cezarId: cezarId, cezarStatic: cezarStatic)
    }

    private func finish(_ phase: Phase, _ reason: String?) {
        if finished { return }
        finished = true
        socket?.close(1000)
        socket = nil
        // Now, not after the 300 s timer.
        actor.shutdown()
        updates(state(phase, reason))
    }

    private func onText(_ text: String) {
        guard let frame = RelayJson.object(text) else { return }
        switch RelayJson.string(frame, "t") {
        case "hello":
            hello = true
            if RelayJson.int(frame, "protocol", 1) != 1 { finish(.failed, "update-app") }
        case "peer-joined":
            onPeerJoined()
        case "peer-left":
            finish(.failed, "lost")
        default:
            break // Readers ignore what they do not know (§ 4).
        }
    }

    private func onPeerJoined() {
        if !hello || handshake != nil { return }
        let prologue = Self.PROLOGUE_LABEL + secret.locatorBytes
        let started = NoiseHandshake.xxpsk3Initiator(prologue: prologue, staticSecret: keys.x25519Secret, psk: secret.psk)
        handshake = started
        do {
            try sendData(started.writeMessage([]))
        } catch {
            finish(.failed, "lost")
            return
        }
        actor.schedule(afterMs: Self.XX_DEADLINE_MS) { [weak self] in
            self?.post { client in
                if client.transportKeys == nil { client.finish(.failed, "timeout") }
            }
        }
        actor.schedule(afterMs: outcomeDeadlineMs) { [weak self] in
            self?.post { $0.finish(.failed, "timeout") }
        }
    }

    private func sendData(_ ciphertext: [UInt8]) throws {
        guard let socket, socket.sendBinary([1] + ciphertext) else { throw RelayIOError("socket refused the frame") }
    }

    private func onBinary(_ frame: [UInt8]) {
        guard let first = frame.first, first == 1, handshake != nil else {
            finish(.failed, "lost")
            return
        }
        let ciphertext = Array(frame.dropFirst())
        do {
            if let transportKeys {
                try onMessage(TunnelRecord.unpad(transportKeys.receive.decrypt(ciphertext)))
            } else {
                try onSecondMessage(ciphertext)
            }
        } catch {
            finish(.failed, "internal")
        }
    }

    private func onSecondMessage(_ message: [UInt8]) throws {
        guard let handshake else { return }
        let payload: [UInt8]
        do {
            payload = try handshake.readMessage(message)
        } catch {
            // A damaged message. `psk3` is only mixed in the third, so a wrong PSK fails at cezar: this phone sees `lost`.
            finish(.failed, "internal")
            return
        }
        if !payload.isEmpty {
            finish(.failed, "internal")
            return
        }
        guard let remote = handshake.remoteStatic else {
            finish(.failed, "internal")
            return
        }
        if let pinned = secret.pinnedKey, !Bytes.constantTimeEqual(pinned, remote) {
            finish(.failed, "pin-mismatch")
            return
        }
        let phone: [String: Any] = [
            "name": name, "platform": "ios", "relayKey": Bytes.base64url(keys.relayKey()),
            "tunnel": ["min": TunnelSession.TUNNEL_MIN, "max": TunnelSession.TUNNEL_MAX],
        ]
        try sendData(handshake.writeMessage(TunnelRecord.pad(Bytes.utf8(RelayJson.string(of: phone)))))
        transportKeys = try handshake.split()
        digits = PairSecret.sasDigits(handshake.handshakeHash)
        cezarStatic = remote
    }

    private func onMessage(_ bytes: [UInt8]) throws {
        if bytes.count > Self.MAX_MESSAGE_BYTES {
            finish(.failed, "internal")
            return
        }
        guard let message = RelayJson.object(bytes) else { throw RelayIOError("not a JSON object") }
        switch RelayJson.string(message, "t") {
        case "pending":
            try onPending(message)
        case "approved":
            if cezarId == nil { finish(.failed, "internal") } else { finish(.approved, nil) }
        case "denied":
            finish(.failed, "denied")
        case "failure":
            try onFailure(message)
        default:
            break // A later cezar may say more.
        }
    }

    private func onPending(_ message: [String: Any]) throws {
        // The six digits on screen were shown for this cezar.
        if cezarId != nil { return }
        let relayKey = Bytes.fromBase64url(RelayJson.string(message, "relayKey"), length: 32)
        let named = RelayJson.string(message, "label")
        guard let tunnel = message["tunnel"] as? [String: Any] else { throw RelayJson.Missing(key: "tunnel") }
        guard let relayKey, !named.isEmpty else {
            finish(.failed, "internal")
            return
        }
        let problem = try Self.tunnelProblem(tunnel)
        if problem != 0 {
            finish(.failed, problem < 0 ? "update-app" : "update-cezar")
            return
        }
        cezarId = RelayIds.id(relayKey)
        label = Self.safeName(named)
        updates(state(.confirm, nil))
    }

    /// Negative: this app is too old. Positive: cezar is. Zero: a shared version exists.
    static func tunnelProblem(_ tunnel: [String: Any]) throws -> Int {
        let low = try RelayJson.requiredInt(tunnel, "min")
        let high = try RelayJson.requiredInt(tunnel, "max")
        if min(TunnelSession.TUNNEL_MAX, high) >= max(TunnelSession.TUNNEL_MIN, low) { return 0 }
        return TunnelSession.TUNNEL_MAX < low ? -1 : 1
    }

    private func onFailure(_ message: [String: Any]) throws {
        let reason = RelayJson.string(message, "reason")
        if reason == "tunnel-unsupported", let tunnel = message["tunnel"] as? [String: Any] {
            finish(.failed, try Self.tunnelProblem(tunnel) < 0 ? "update-app" : "update-cezar")
            return
        }
        finish(.failed, Self.knownFailures.contains(reason) ? reason : "internal")
    }

    private func onClosed(_ code: Int) {
        switch code {
        case 4404: finish(.failed, "not-found")
        case 4408: finish(.failed, "expired")
        case 4410: finish(.failed, "taken")
        case 4426: finish(.failed, "update-app")
        case 4429: finish(.failed, "rate-limited")
        case 4503: finish(.failed, "relay-disabled")
        default: finish(.failed, "lost")
        }
    }

    private func onRefused(_ status: Int) {
        switch status {
        case 0: finish(.failed, "relay-unreachable")
        case 404: finish(.failed, "not-found")
        case 409: finish(.failed, "taken")
        case 426: finish(.failed, "update-app")
        case 429: finish(.failed, "rate-limited")
        case 503: finish(.failed, "relay-disabled")
        default: finish(.failed, "internal")
        }
    }
}
