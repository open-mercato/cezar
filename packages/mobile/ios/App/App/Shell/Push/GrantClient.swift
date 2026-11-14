import Foundation

/// `POST /v1/push-grants` and `/v1/push-grants/revoke`, each signed by the server's device key (RELAY_PROTOCOL.md §§ 3.1, 7).
final class GrantClient {
    static let grantsPath = "/v1/push-grants"
    static let revokePath = "/v1/push-grants/revoke"
    /// § 7: `platform` is `ios` or `android`.
    static let platform = "ios"
    private static let maxGrant = 4096
    private static let maxToken = 1024

    /// Why a grant was not had. Holds no token and no grant, so it is safe to log.
    struct Failure: Error, Equatable {
        let message: String
        let status: Int
        /// Seconds, or -1.
        let retryAfter: Int64
    }

    /// The revoke table of § 7. Only `done` means the denial is stored.
    enum Revoke { case done, stopped, retry }

    struct RevokeAnswer: Equatable {
        let outcome: Revoke
        let status: Int
        /// Seconds, or -1 for full jitter.
        let retryAfter: Int64
    }

    private let relay: PushRelay
    private let clock: () -> Int64
    private let lock = NSLock()
    /// The relay's clock minus ours, learned from a 401's `Date` (§ 3.2).
    private var skewMs: Int64 = 0

    /// `clock`: milliseconds since the epoch.
    init(relay: PushRelay, clock: @escaping () -> Int64) {
        self.relay = relay
        self.clock = clock
    }

    /// Exactly the three keys § 7 lists: the relay refuses any other.
    static func grantBody(token: String, cezarKey: String) -> [UInt8] {
        Bytes.utf8("{\"platform\":\"\(platform)\",\"token\":\(PushJson.quote(token)),\"cezarKey\":\(PushJson.quote(cezarKey))}")
    }

    static func revokeBody(grant: String) -> [UInt8] {
        Bytes.utf8("{\"grant\":\(PushJson.quote(grant))}")
    }

    /// The three proof headers for one `POST`, and its content type.
    static func proofHeaders(_ keys: DeviceKeys, path: String, body: [UInt8], time: Int64) -> [String: String] {
        ["Content-Type": "application/json",
         "X-Cezar-Relay-Key": Bytes.base64url(RelayCrypto.ed25519Public(keys.ed25519Seed)),
         "X-Cezar-Relay-Time": String(time),
         "X-Cezar-Relay-Sig": RelayIds.sign(keys.ed25519Seed, RelayIds.postProof(path: path, body: body, time: time))]
    }

    func obtain(origin: String, keys: DeviceKeys, token: String?, cezarKey: String?) throws -> PushGrant {
        guard let token, !token.isEmpty, token.utf16.count <= Self.maxToken else { throw Failure(message: "no usable push token", status: 0, retryAfter: -1) }
        guard let cezarKey, Bytes.fromBase64url(cezarKey, length: 32) != nil else {
            throw Failure(message: "cezar sent no usable key", status: 0, retryAfter: -1)
        }
        let answer: PushRelayAnswer
        do {
            answer = try post(origin, Self.grantsPath, keys, Self.grantBody(token: token, cezarKey: cezarKey))
        } catch {
            throw Failure(message: "relay unreachable", status: 0, retryAfter: -1)
        }
        guard answer.status == 200 else { throw Failure(message: "relay answered \(answer.status)", status: answer.status, retryAfter: answer.retryAfter) }
        let bad = Failure(message: "relay sent a bad grant", status: 200, retryAfter: -1)
        guard let body = PushJson.object(answer.body), let grant = PushJson.text(body, "grant"),
              let grantId = PushJson.text(body, "grantId"), body["expiresAt"] is NSNumber else { throw bad }
        let expiresAt = PushJson.long(body, "expiresAt")
        guard !grant.isEmpty, grant.utf16.count <= Self.maxGrant, Self.validGrantId(grantId), expiresAt > 0 else { throw bad }
        return PushGrant(grant: grant, grantId: grantId, expiresAt: expiresAt, cezarKey: cezarKey, handedOver: false)
    }

    func revoke(origin: String, keys: DeviceKeys, grant: String) -> RevokeAnswer {
        do {
            return Self.classify(try post(origin, Self.revokePath, keys, Self.revokeBody(grant: grant)))
        } catch {
            return RevokeAnswer(outcome: .retry, status: 0, retryAfter: -1)
        }
    }

    /// § 7: keep the grant until 204, 400, 401 or 410, and nothing else. A 404 or 405 may come from a
    /// proxy in front of the relay, and stopping on it would drop a forgotten server's key early.
    static func classify(_ answer: PushRelayAnswer) -> RevokeAnswer {
        switch answer.status {
        case 204: return RevokeAnswer(outcome: .done, status: 204, retryAfter: -1)
        case 400, 401, 410: return RevokeAnswer(outcome: .stopped, status: answer.status, retryAfter: -1)
        default: return RevokeAnswer(outcome: .retry, status: answer.status, retryAfter: answer.retryAfter)
        }
    }

    /// `[A-Za-z0-9_-]{22}`, as cezar ids are.
    static func validGrantId(_ value: String) -> Bool {
        value.utf8.count == 22 && value.utf8.allSatisfy(PushTap.isIdByte)
    }

    /// Retries a 401 once, correcting the time by the relay's `Date` (§ 3.2).
    private func post(_ origin: String, _ path: String, _ keys: DeviceKeys, _ body: [UInt8]) throws -> PushRelayAnswer {
        let answer = try send(origin, path, keys, body)
        guard answer.status == 401, answer.date > 0 else { return answer }
        let skew = answer.date - clock()
        lock.lock()
        skewMs = skew
        lock.unlock()
        return try send(origin, path, keys, body)
    }

    private func send(_ origin: String, _ path: String, _ keys: DeviceKeys, _ body: [UInt8]) throws -> PushRelayAnswer {
        lock.lock()
        let skew = skewMs
        lock.unlock()
        let time = (clock() + skew) / 1000
        return try relay.post(url: origin + path, headers: Self.proofHeaders(keys, path: path, body: body, time: time), body: body)
    }
}
