import Foundation

/// One HTTP exchange inside a session (RELAY_PROTOCOL.md § 12): both windows, and the frames for its reader.
final class TunnelStream {
    enum Kind { case head, data, end, reset, lost }

    /// What the reader gets next, in wire order.
    struct Event {
        let kind: Kind
        var status = 0
        var headers: [TunnelFrame.Header] = []
        var data: [UInt8] = []
        var code = 0
    }

    /// The request half cannot go on: the stream was reset or the session is gone.
    struct Gone: Error {}

    /// Near the § 12.2 limit of 131,072: each `WINDOW` counts against the relay's `framesPerSecond`.
    private static let CREDIT_EVERY = 120_000

    private let session: TunnelSession
    private let events = BlockingQueue<Event>()
    /// Java's monitor on the stream: its lock, `wait` and `notifyAll`.
    private let monitor = NSCondition()
    let id: Int
    private var sendWindow = TunnelFrame.MAX_WINDOW
    private var receiveWindow = TunnelFrame.MAX_WINDOW
    private var unacknowledged = 0
    private var localEnded = false
    private var remoteEnded = false
    private var headSeen = false
    private var finished = false

    init(session: TunnelSession, id: Int) {
        self.session = session
        self.id = id
    }

    /// Waits for window, and splits to the largest `DATA` payload. Forwards as it arrives (§ 12.2).
    func write(_ bytes: [UInt8], offset: Int = 0, length: Int? = nil) throws {
        var at = offset
        var left = length ?? bytes.count - offset
        while left > 0 {
            monitor.lock()
            while sendWindow == 0 && !finished { _ = monitor.wait(until: Date(timeIntervalSinceNow: 1)) }
            if finished {
                monitor.unlock()
                throw Gone()
            }
            let chunk = min(left, sendWindow, session.maxData())
            sendWindow -= chunk
            monitor.unlock()
            try session.sendFrame(TunnelFrame.data(stream: id, bytes, offset: at, length: chunk))
            at += chunk
            left -= chunk
        }
    }

    /// The request is complete.
    func finishRequest() throws {
        monitor.lock()
        if finished || localEnded {
            monitor.unlock()
            return
        }
        localEnded = true
        monitor.unlock()
        try session.sendFrame(TunnelFrame.end(stream: id))
        maybeFinished()
    }

    /// The next event, or nil after `timeoutMs`.
    func next(timeoutMs: Int64) -> Event? { events.poll(timeoutMs: timeoutMs) }

    /// Credit for bytes the consumer really took, so a stalled page stalls the sender (§ 12.2).
    func consumed(_ bytes: Int) {
        var credit = 0
        monitor.lock()
        if finished || remoteEnded {
            monitor.unlock()
            return
        }
        unacknowledged += bytes
        if unacknowledged >= Self.CREDIT_EVERY {
            credit = unacknowledged
            unacknowledged = 0
            receiveWindow += credit
        }
        monitor.unlock()
        if credit > 0 { sendQuietly(TunnelFrame.window(stream: id, increment: credit)) }
    }

    /// The reader went away.
    func cancel(_ code: Int) {
        monitor.lock()
        if finished {
            monitor.unlock()
            return
        }
        finishLocked()
        monitor.unlock()
        session.forget(self)
        sendQuietly(TunnelFrame.reset(stream: id, code: code))
    }

    private func sendQuietly(_ frame: [UInt8]) {
        // The session's own end reaches every stream.
        try? session.sendFrame(frame)
    }

    private func finishLocked() {
        finished = true
        monitor.broadcast()
    }

    private func maybeFinished() {
        monitor.lock()
        let done = !finished && localEnded && remoteEnded
        if done { finishLocked() }
        monitor.unlock()
        if done { session.forget(self) }
    }

    func onHead(_ frame: TunnelFrame) throws {
        monitor.lock()
        if headSeen || remoteEnded {
            monitor.unlock()
            throw TunnelRecord.Malformed("second HEAD")
        }
        headSeen = true
        monitor.unlock()
        events.add(Event(kind: .head, status: frame.status, headers: frame.headers))
    }

    func onData(_ frame: TunnelFrame) throws {
        monitor.lock()
        if !headSeen || remoteEnded {
            monitor.unlock()
            throw TunnelRecord.Malformed("DATA out of order")
        }
        if frame.data.isEmpty {
            monitor.unlock()
            return
        }
        let over = frame.data.count > receiveWindow
        if !over { receiveWindow -= frame.data.count }
        monitor.unlock()
        if over {
            events.add(Event(kind: .reset, code: TunnelFrame.RESET_FLOW_CONTROL))
            cancel(TunnelFrame.RESET_FLOW_CONTROL)
            return
        }
        events.add(Event(kind: .data, data: frame.data))
    }

    func onEnd() throws {
        monitor.lock()
        if !headSeen || remoteEnded {
            monitor.unlock()
            throw TunnelRecord.Malformed("END out of order")
        }
        remoteEnded = true
        monitor.unlock()
        events.add(Event(kind: .end))
        maybeFinished()
    }

    func onReset(_ code: Int) {
        monitor.lock()
        if finished {
            monitor.unlock()
            return
        }
        finishLocked()
        monitor.unlock()
        session.forget(self)
        events.add(Event(kind: .reset, code: code))
    }

    func onWindow(_ increment: Int) {
        monitor.lock()
        let over = sendWindow + increment > TunnelFrame.MAX_WINDOW
        if !over {
            sendWindow += increment
            monitor.broadcast()
        }
        monitor.unlock()
        if over {
            events.add(Event(kind: .reset, code: TunnelFrame.RESET_FLOW_CONTROL))
            cancel(TunnelFrame.RESET_FLOW_CONTROL)
        }
    }

    func onLost() {
        monitor.lock()
        finishLocked()
        monitor.unlock()
        events.add(Event(kind: .lost))
    }
}
