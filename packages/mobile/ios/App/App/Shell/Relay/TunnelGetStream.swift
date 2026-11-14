import Foundation

/// A GET whose body never ends by itself, read as it arrives. `TunnelHttp` buffers whole answers instead.
final class TunnelGetStream {
    /// The body ended with `END`: Java's `EOFException`.
    struct EndOfStream: Error {}

    private static let HEAD_TIMEOUT_MS: Int64 = 10000

    private let stream: TunnelStream
    private let statusCode: Int

    private init(stream: TunnelStream, status: Int) {
        self.stream = stream
        statusCode = status
    }

    /// Blocks until the head. `path` is origin-form, as for `TunnelHttp`.
    static func open(session: TunnelSession?, path: String, headers: [String: String]) throws -> TunnelGetStream {
        guard let session else { throw RelayIOError("no session") }
        let forwarded = headers.map { TunnelFrame.Header(name: $0.key.lowercased(), value: $0.value) }
        let stream = try session.open(method: "GET", target: path, headers: forwarded)
        do {
            try stream.finishRequest()
            guard let head = stream.next(timeoutMs: HEAD_TIMEOUT_MS), head.kind == .head else { throw RelayIOError("no head") }
            return TunnelGetStream(stream: stream, status: head.status)
        } catch {
            stream.cancel(TunnelFrame.RESET_CANCELLED)
            throw error
        }
    }

    func status() -> Int { statusCode }

    /// The next bytes, credited back as taken, or nil after `timeoutMs`. Throws once the stream has ended.
    func read(timeoutMs: Int64) throws -> [UInt8]? {
        guard let event = stream.next(timeoutMs: timeoutMs) else { return nil }
        switch event.kind {
        case .data:
            stream.consumed(event.data.count)
            return event.data
        case .end:
            throw EndOfStream()
        default:
            throw RelayIOError("stream ended")
        }
    }

    func close() {
        stream.cancel(TunnelFrame.RESET_CANCELLED)
    }
}
