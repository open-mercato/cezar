import Foundation

/// The phone's side of the relay account (RELAY_PROTOCOL.md § 18), as AccountClient.java: status and
/// resend signed by this phone's device key. Confirming is the emailed link's button at the relay.
final class AccountClient {
    static let statusPath = "/v1/accounts/status"
    static let resendPath = "/v1/accounts/resend"

    /// The relay's status object, reduced to what the app shows.
    struct Status: Equatable {
        /// `confirmed`, `pending` or `blocked`.
        let state: String
        let email: String?
        /// Seconds, or -1 when confirmed.
        let secondsLeft: Int64
    }

    /// A refused call. `code` is the relay's, or `unreachable`. Holds no secret.
    struct Failure: Error, Equatable {
        let code: String
        let status: Int
        let retryAfter: Int64
    }

    private let relay: PushRelay
    private let clock: () -> Int64

    init(relay: PushRelay, clock: @escaping () -> Int64) {
        self.relay = relay
        self.clock = clock
    }

    static func phoneBody(cezarId: String, deviceId: String) -> [UInt8] {
        Bytes.utf8("{\"cezar\":\(PushJson.quote(cezarId)),\"device\":\(PushJson.quote(deviceId))}")
    }

    func status(origin: String, keys: DeviceKeys, cezarId: String) throws -> Status {
        let body = try call(origin, Self.statusPath, Self.phoneBody(cezarId: cezarId, deviceId: keys.deviceId()), keys)
        return try Self.parseStatus(body["status"])
    }

    /// When the new code expires, Unix seconds.
    @discardableResult
    func resend(origin: String, keys: DeviceKeys, cezarId: String) throws -> Int64 {
        let body = try call(origin, Self.resendPath, Self.phoneBody(cezarId: cezarId, deviceId: keys.deviceId()), keys)
        return (body["expiresAt"] as? NSNumber)?.int64Value ?? 0
    }

    static func parseStatus(_ value: Any?) throws -> Status {
        guard let status = value as? [String: Any], let state = status["state"] as? String,
              ["confirmed", "pending", "blocked"].contains(state) else { throw Failure(code: "bad-answer", status: 200, retryAfter: -1) }
        let left = (status["secondsLeft"] as? NSNumber)?.int64Value ?? -1
        return Status(state: state, email: status["email"] as? String, secondsLeft: left)
    }

    private func call(_ origin: String, _ path: String, _ body: [UInt8], _ keys: DeviceKeys?) throws -> [String: Any] {
        let headers = keys.map { GrantClient.proofHeaders($0, path: path, body: body, time: clock() / 1000) } ?? ["Content-Type": "application/json"]
        let answer: PushRelayAnswer
        do {
            answer = try relay.post(url: origin + path, headers: headers, body: body)
        } catch {
            throw Failure(code: "unreachable", status: 0, retryAfter: -1)
        }
        let json = (try? JSONSerialization.jsonObject(with: Data(answer.body.utf8))) as? [String: Any] ?? [:]
        if (200..<300).contains(answer.status) { return json }
        let code = json["code"] as? String ?? (answer.status >= 500 ? "unavailable" : String(answer.status))
        throw Failure(code: code, status: answer.status, retryAfter: answer.retryAfter)
    }

    /// What the confirm screen says for a refusal.
    static func message(_ failure: Failure) -> String {
        switch failure.code {
        case "rate-limited": return "Too many tries. Try again later."
        case "already-confirmed": return "This email is already confirmed. Tap Check now."
        case "no-account": return "Your computer has no email set up yet. Enter one in cezar's Settings, under Connect a phone."
        case "unreachable": return "Can't reach the Cezar relay. Check your connection and try again."
        case "email-unavailable": return "The relay could not send the email. Try again later."
        default: return "The relay could not do that right now. Try again later."
        }
    }
}
