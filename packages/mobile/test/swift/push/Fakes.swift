import Foundation

let cezarKeyFixture = Bytes.base64url(RelayCrypto.ed25519Public([UInt8](repeating: 0, count: 32)))
let grantIdFixture = "AAAAAAAAAAAAAAAAAAAAAA"

struct Offline: Error {}

/// `/workspace/phone/push` as cezar answers it inside the session.
final class FakeCezar {
    var calls: [String] = []
    var bodies: [String] = []
    var available = true
    var offline = false
    /// cezar turned push off between the GET and the PUT.
    var refusePut = false
    /// The session drops between the GET and the PUT.
    var dropOnPut = false
    var grantId: String?
    var managerId: String?

    func api() -> CezarPush {
        CezarPush(http: { [unowned self] method, path, headers, body in try self.send(method, path, headers, body) },
                  userAgent: "CezarMobile/test (ios)")
    }

    func send(_ method: String, _ path: String, _ headers: [String: String], _ body: [UInt8]?) throws -> HttpAnswer {
        calls.append("\(method) \(path)")
        if offline || (dropOnPut && method == "PUT") { throw Offline() }
        if let body { bodies.append(text(body)) }
        switch method {
        case "PUT":
            if !available || refusePut { return HttpAnswer(status: 409, headers: [:], body: "{\"error\":\"push is off\"}") }
            grantId = PushJson.object(bodies.last!)?["grantId"] as? String
            return state()
        case "DELETE":
            grantId = nil
            return HttpAnswer(status: 200, headers: [:], body: "{\"ok\":true}")
        default:
            return state()
        }
    }

    private func state() -> HttpAnswer {
        var body: [String: Any] = ["available": available]
        if available { body["cezarKey"] = cezarKeyFixture }
        if let grantId {
            body["grantId"] = grantId
            body["grantExpiresAt"] = 1_807_776_000
        }
        if let managerId { body["managerId"] = managerId }
        return HttpAnswer(status: 200, headers: [:], body: PushJson.string(body))
    }
}

/// The relay's push routes, scripted. An empty script is a network failure.
final class FakeRelay: PushRelay {
    struct Sent {
        let url: String
        let headers: [String: String]
        let body: [UInt8]
    }

    var answers: [PushRelayAnswer] = []
    var sent: [Sent] = []

    @discardableResult
    func answer(_ status: Int, _ body: String) -> FakeRelay {
        answers.append(PushRelayAnswer(status: status, code: nil, retryAfter: -1, date: -1, body: body))
        return self
    }

    @discardableResult
    func answer(_ answer: PushRelayAnswer) -> FakeRelay {
        answers.append(answer)
        return self
    }

    /// Out of range reads as nothing sent, so a missing request fails a check instead of trapping.
    func url(_ index: Int) -> String { index < sent.count ? sent[index].url : "" }
    func body(_ index: Int) -> String { index < sent.count ? text(sent[index].body) : "" }

    static func grant(_ grantId: String, _ expiresAt: Int64) -> String {
        "{\"grant\":\"sealed-\(grantId)\",\"grantId\":\"\(grantId)\",\"expiresAt\":\(expiresAt)}"
    }

    func post(url: String, headers: [String: String], body: [UInt8]) throws -> PushRelayAnswer {
        sent.append(Sent(url: url, headers: headers, body: body))
        if answers.isEmpty { throw Offline() }
        return answers.removeFirst()
    }
}

final class FakeTokens: TokenSource {
    var pushAvailable = true
    var value: String? = "token-1"
    var calls = 0

    func available() -> Bool { pushAvailable }

    func token() throws -> String {
        calls += 1
        guard let value else { throw Offline() }
        return value
    }
}

final class MemoryKeys: PushCoordinator.Keys {
    var keys: [String: DeviceKeys] = [:]
    var deleted: [String] = []

    func get(_ serverId: String) -> DeviceKeys? { keys[serverId] }

    func delete(_ serverId: String) {
        deleted.append(serverId)
        keys[serverId] = nil
    }
}
