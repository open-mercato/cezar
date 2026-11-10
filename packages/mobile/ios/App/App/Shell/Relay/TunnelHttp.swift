import Foundation

/// One native request inside the session, for the app's own calls. `path` is origin-form: a relay server has no origin.
final class TunnelHttp: @unchecked Sendable {
    struct Answer {
        let status: Int
        /// Lower-case names, every value in arrival order.
        let headers: [String: [String]]
        let body: String
    }

    private static let TIMEOUT_MS: Int64 = 10000
    private static let MAX_BODY = 256 * 1024

    private let sessions: () -> TunnelSession?

    init(sessions: @escaping () -> TunnelSession?) {
        self.sessions = sessions
    }

    /// Blocks. `body` may be nil. A body goes with its `content-length`, which the dispatcher checks (§ 13.1).
    func send(method: String, path: String, headers: [String: String], body: [UInt8]?) throws -> Answer {
        guard let session = sessions() else { throw RelayIOError("no session") }
        var forwarded = headers.map { TunnelFrame.Header(name: $0.key.lowercased(), value: $0.value) }
        if let body { forwarded.append(TunnelFrame.Header(name: "content-length", value: String(body.count))) }
        let stream = try session.open(method: method, target: path, headers: forwarded)
        defer { stream.cancel(TunnelFrame.RESET_CANCELLED) }
        if let body, !body.isEmpty { try stream.write(body) }
        try stream.finishRequest()
        return try Self.read(stream)
    }

    private static func read(_ stream: TunnelStream) throws -> Answer {
        let deadline = relayNowMs() + TIMEOUT_MS
        var headers: [String: [String]] = [:]
        var body: [UInt8] = []
        var status = 0
        while true {
            let left = deadline - relayNowMs()
            guard left > 0, let event = stream.next(timeoutMs: left) else { throw RelayIOError("timed out") }
            switch event.kind {
            case .head:
                status = event.status
                for header in event.headers { headers[header.name, default: []].append(header.value) }
            case .data:
                if body.count < MAX_BODY { body += event.data }
                stream.consumed(event.data.count)
            case .end:
                return Answer(status: status, headers: headers, body: String(decoding: body, as: UTF8.self))
            default:
                throw RelayIOError("stream ended")
            }
        }
    }
}
