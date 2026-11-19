import Foundation
import Network

/// One accepted loopback connection as Java's blocking socket: reads wait up to `readTimeoutMs`, and a
/// flush returns once the stack has taken the bytes, so a page that stops reading stalls its writer (§ 12.2).
final class ProxyConnection: ProxyInput {
    /// Java's `SocketTimeoutException`.
    struct Timeout: Error {}

    private let connection: NWConnection
    private let queue: DispatchQueue
    private let condition = NSCondition()
    private var buffer: [UInt8] = []
    private var readAt = 0
    private var eof = false
    private var cancelled = false
    private var receiving = false
    private var output: [UInt8] = []
    /// Java's `SO_TIMEOUT`.
    var readTimeoutMs: Int64 = 30000

    init(_ connection: NWConnection) {
        self.connection = connection
        queue = DispatchQueue(label: "cezar-proxy-connection")
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.markGone()
            default: break
            }
        }
        connection.start(queue: queue)
    }

    private func markGone() {
        condition.lock()
        eof = true
        cancelled = true
        condition.broadcast()
        condition.unlock()
    }

    func cancel() {
        connection.cancel()
        markGone()
    }

    /// Under the condition's lock: asks for more bytes unless a request is already out.
    private func receiveLocked() {
        if receiving || eof { return }
        receiving = true
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            self.condition.lock()
            if let data, !data.isEmpty { self.buffer += data }
            if isComplete || error != nil { self.eof = true }
            self.receiving = false
            self.condition.broadcast()
            self.condition.unlock()
        }
    }

    /// Under the lock: true when there are bytes, false at the end; throws past the timeout.
    private func fillLocked(timeoutMs: Int64) throws -> Bool {
        let deadline = Date(timeIntervalSinceNow: Double(timeoutMs) / 1000)
        while readAt == buffer.count {
            if eof { return false }
            receiveLocked()
            if !condition.wait(until: deadline) && readAt == buffer.count && !eof { throw Timeout() }
        }
        return true
    }

    private func compactLocked() {
        if readAt > 65536 && readAt * 2 > buffer.count {
            buffer.removeFirst(readAt)
            readAt = 0
        }
    }

    func read() throws -> Int {
        condition.lock()
        defer { condition.unlock() }
        guard try fillLocked(timeoutMs: readTimeoutMs) else { return -1 }
        let b = buffer[readAt]
        readAt += 1
        compactLocked()
        return Int(b)
    }

    func read(_ into: inout [UInt8], max: Int) throws -> Int {
        if max == 0 { return 0 }
        condition.lock()
        defer { condition.unlock() }
        guard try fillLocked(timeoutMs: readTimeoutMs) else { return -1 }
        let count = min(max, buffer.count - readAt, into.count)
        into.replaceSubrange(0..<count, with: buffer[readAt..<readAt + count])
        readAt += count
        compactLocked()
        return count
    }

    /// A stalled SSE page that went away must give its stream back. Bytes it sent stay buffered.
    func clientLeft() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        if readAt < buffer.count { return false }
        return (try? fillLocked(timeoutMs: 1)) == false
    }

    func write(_ bytes: [UInt8]) {
        output += bytes
    }

    /// Blocks until the stack has the bytes; throws when the connection is gone.
    func flush() throws {
        if output.isEmpty { return }
        let data = Data(output)
        output.removeAll(keepingCapacity: true)
        let done = Locked<Result<Void, Error>?>(nil)
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            done.value = error.map { .failure($0) } ?? .success(())
            guard let self else { return }
            self.condition.lock()
            self.condition.broadcast()
            self.condition.unlock()
        })
        condition.lock()
        defer { condition.unlock() }
        while done.value == nil && !cancelled { condition.wait() }
        if case .failure(let error)? = done.value { throw error }
        if done.value == nil { throw RelayIOError("connection gone") }
    }
}
