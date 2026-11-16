import Foundation

/// `/api/v1/workspace/phone/push`, asked inside the server's own session (spec R5 as built).
final class CezarPush {
    static let path = "/api/v1/workspace/phone/push"

    struct Failure: Error, Equatable {
        let message: String
    }

    /// One request inside the session: method, path, headers, body. The app passes the tunnel's; tests pass a fake.
    typealias Http = (String, String, [String: String], [UInt8]?) throws -> HttpAnswer

    /// `phonePushStateSchema`.
    struct State: Equatable {
        let available: Bool
        /// cezar's Ed25519 key, checked to be 32 bytes of base64url; nil otherwise.
        let cezarKey: String?
        let grantId: String?
        let grantExpiresAt: Int64
        let managerId: String?

        /// A cezar too old to have the route, or with push off.
        static let off = State(available: false, cezarKey: nil, grantId: nil, grantExpiresAt: 0, managerId: nil)

        /// Readers ignore unknown keys. A key that is not 32 bytes reads as push off: no grant can name it.
        static func parse(_ json: String) throws -> State {
            guard let body = PushJson.object(json) else { throw Failure(message: "cezar sent bad push state") }
            let key = PushJson.text(body, "cezarKey")
            let usable = Bytes.fromBase64url(key, length: 32) != nil
            return State(available: PushJson.bool(body, "available") && usable, cezarKey: usable ? key : nil,
                         grantId: PushJson.text(body, "grantId"), grantExpiresAt: PushJson.long(body, "grantExpiresAt"),
                         managerId: PushJson.text(body, "managerId"))
        }
    }

    private let http: Http
    private let userAgent: String

    init(http: @escaping Http, userAgent: String) {
        self.http = http
        self.userAgent = userAgent
    }

    func get() throws -> State {
        let answer = try http("GET", Self.path, headers(json: false), nil)
        if answer.status == 404 { return .off }
        guard answer.status == 200 else { throw Failure(message: "cezar answered \(answer.status)") }
        return try State.parse(answer.body)
    }

    /// Nil when cezar has push off (409).
    func put(_ grant: PushGrant) throws -> State? {
        let body = "{\"grant\":\(PushJson.quote(grant.grant)),\"grantId\":\(PushJson.quote(grant.grantId)),\"expiresAt\":\(grant.expiresAt)}"
        let answer = try http("PUT", Self.path, headers(json: true), Bytes.utf8(body))
        if answer.status == 409 { return nil }
        guard answer.status == 200 else { throw Failure(message: "cezar answered \(answer.status)") }
        return try State.parse(answer.body)
    }

    func delete() throws {
        let answer = try http("DELETE", Self.path, headers(json: false), nil)
        // 404: a cezar with no such route holds no grant either.
        guard answer.status == 200 || answer.status == 404 else { throw Failure(message: "cezar answered \(answer.status)") }
    }

    private func headers(json: Bool) -> [String: String] {
        var headers = ["Accept": "application/json", "User-Agent": userAgent]
        if json { headers["Content-Type"] = "application/json" }
        return headers
    }
}
