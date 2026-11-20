import Foundation

/// Stage 1 push: `GET /workspace/phone/signals` held open inside a live session while the server's
/// switch is on (spec R5 as built). Reopened with backoff while the session lasts; a 404 or 409
/// stops it for this view's life. Logs statuses only.
final class SignalStream {
    static let path = "/api/v1/workspace/phone/signals"
    /// cezar pings every 30 s: three missed pings and the stream is dead, whatever the session says.
    static let silenceMs: Int64 = 95_000
    static let maxBackoffMs: Int64 = 60_000

    /// Opens the stream in the current session; throws when there is none.
    protocol Source {
        func open() throws -> Connection
    }

    protocol Connection: AnyObject {
        var status: Int { get }

        /// The next bytes, nil after `timeoutMs`; throws once the stream has ended.
        func read(timeoutMs: Int64) throws -> [UInt8]?

        func close()
    }

    /// `managerId` is nil, or passed `PushTap.validManagerId`. A throw is logged, never the stream's end.
    typealias Listener = (String?) throws -> Void

    /// Waits `ms`, or less once stopped.
    typealias Sleeper = (Int64) -> Void

    /// Runs the loop off the caller's thread.
    typealias Executor = (@escaping () -> Void) -> Void

    enum End { case stopped, refused, noSession }

    enum Next { case read, stop, retry }

    /// A thread of its own: the loop blocks for minutes, which a Dispatch worker should not.
    static let thread: Executor = { work in
        let thread = Thread(block: work)
        thread.name = "cezar.push.signals"
        thread.start()
    }

    private let source: Source
    private let wanted: () -> Bool
    private let listener: Listener
    private let random: () -> Double
    private var sleeper: Sleeper!
    private let lock = NSLock()
    private let wake = NSCondition()
    private var stoppedFlag = false
    private var current: Connection?
    private var running = false
    private var refused = false

    /// `wanted`: the session is up, the switch is on and notifications are allowed. Asked before each open.
    /// `random`: uniform in [0, 1); the system generator unless a test pins it.
    init(source: Source, wanted: @escaping () -> Bool, listener: @escaping Listener,
         random: @escaping () -> Double = { Double.random(in: 0..<1) }, sleeper: Sleeper? = nil) {
        self.source = source
        self.wanted = wanted
        self.listener = listener
        self.random = random
        self.sleeper = sleeper ?? { [unowned self] ms in self.await(ms) }
    }

    /// 404: an unknown device or a cezar without the route. 409: cezar has `CEZ_PUSH=0`. Neither changes by asking again.
    static func decide(_ status: Int) -> Next {
        if status == 200 { return .read }
        if status == 404 || status == 409 { return .stop }
        return .retry
    }

    /// Full jitter: 1 s to min(60 s, 2^n s).
    func backoffMs(_ attempts: Int) -> Int64 {
        let cap = min(Self.maxBackoffMs, Int64(1000) << Int64(min(attempts + 1, 20)))
        return 1000 + Int64(random() * Double(cap - 1000))
    }

    /// The session came up or the switch went on. A no-op while one runs, after a refusal, or once stopped.
    func ensureRunning(_ executor: Executor = SignalStream.thread) {
        lock.lock()
        if running || refused || stoppedFlag {
            lock.unlock()
            return
        }
        running = true
        lock.unlock()
        executor { [self] in
            let end = run()
            lock.lock()
            if end != .noSession { running = false }
            if end == .refused { refused = true }
            lock.unlock()
        }
    }

    /// For good: the view is gone.
    func stop() {
        lock.lock()
        stoppedFlag = true
        let open = current
        lock.unlock()
        open?.close()
        wake.lock()
        wake.broadcast()
        wake.unlock()
    }

    private var stopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stoppedFlag
    }

    /// Blocks until stopped, refused, or no longer wanted. `noSession` has cleared `running` already.
    func run() -> End {
        var attempts = 0
        while true {
            if stopped { return .stopped }
            if !stillWanted() { return .noSession }
            switch once() {
            case .stop: return .refused
            case .read: attempts = 0
            case .retry: break
            }
            if stopped { return .stopped }
            if !stillWanted() { return .noSession }
            sleeper(backoffMs(attempts))
            attempts += 1
        }
    }

    /// One step with `ensureRunning`, so a session that comes back during this exit is not missed.
    private func stillWanted() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if wanted() { return true }
        running = false
        return false
    }

    /// `read` when `ready` arrived before the stream ended, which resets the backoff.
    private func once() -> Next {
        let connection: Connection
        do {
            connection = try source.open()
        } catch {
            return .retry
        }
        lock.lock()
        current = connection
        let already = stoppedFlag
        lock.unlock()
        var ready = false
        defer {
            lock.lock()
            current = nil
            lock.unlock()
            connection.close()
        }
        if already { return .retry }
        let next = Self.decide(connection.status)
        if next != .read {
            PushLog.info("push signals: \(connection.status)")
            return next
        }
        let parser = SignalParser { [self] type, data in
            if type == "ready" { ready = true } else if type == "signal" { onSignal(data) }
        }
        do {
            while !stopped {
                guard let bytes = try connection.read(timeoutMs: Self.silenceMs) else { break }
                parser.feed(bytes)
            }
        } catch {
            // Ended: the session went, or cezar closed it.
        }
        return ready ? .read : .retry
    }

    /// `{ managerId? }`. Anything that is not a JSON object is dropped, not shown.
    private func onSignal(_ data: String) {
        guard let body = PushJson.object(data) else { return }
        let value = body["managerId"] as? String
        let managerId = PushTap.validManagerId(value) ? value : nil
        do {
            try listener(managerId)
        } catch {
            PushLog.info("push signal: not shown")
        }
    }

    private func await(_ ms: Int64) {
        wake.lock()
        defer { wake.unlock() }
        if !stopped { _ = wake.wait(until: Date(timeIntervalSinceNow: Double(ms) / 1000)) }
    }
}
