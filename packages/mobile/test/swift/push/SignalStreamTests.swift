import Foundation

/// SignalStreamTest: the stream's life inside a session: reopen while wanted, stop on 404 and 409 (spec R5, Stage 1).
private let ready = "event: ready\ndata: {}\n\n"

/// One scripted answer: a status, then chunks, then the end. A nil chunk is a read that timed out.
private class Script: SignalStream.Connection {
    let status: Int
    var chunks: [String?]
    var closed = false
    var timedOut = false
    var badTimeout = false

    init(_ status: Int, _ chunks: String?...) {
        self.status = status
        self.chunks = chunks
    }

    func read(timeoutMs: Int64) throws -> [UInt8]? {
        if timeoutMs != SignalStream.silenceMs { badTimeout = true }
        guard !chunks.isEmpty else { throw Offline() }
        guard let next = chunks.removeFirst() else {
            timedOut = true
            return nil
        }
        return Bytes.utf8(next)
    }

    func close() { closed = true }
}

private final class StopOnRead: Script {
    var stream: SignalStream?
    override func read(timeoutMs: Int64) throws -> [UInt8]? {
        let next = try super.read(timeoutMs: timeoutMs)
        stream?.stop()
        return next
    }
}

private final class Scripted: SignalStream.Source {
    /// A Script, or an Error the open throws. Empty: no session.
    var answers: [Any] = []
    var opened: [Script] = []

    func open() throws -> SignalStream.Connection {
        guard !answers.isEmpty else { throw Offline() }
        let next = answers.removeFirst()
        if let error = next as? Error { throw error }
        let script = next as! Script
        opened.append(script)
        return script
    }
}

private final class World {
    let source = Scripted()
    var signals: [String] = []
    var sleeps: [Int64] = []
    /// Bounded, so a stream that never stops fails its checks instead of hanging the suite.
    var wantedFor = 100
    var asked = 0

    func stream() -> SignalStream {
        var seed: UInt64 = 1
        return SignalStream(source: source, wanted: { [unowned self] in
            defer { asked += 1 }
            return asked < wantedFor
        }, listener: { [unowned self] managerId in signals.append(managerId ?? "null") }, random: {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double(seed >> 11) / Double(1 << 53)
        }, sleeper: { [unowned self] ms in sleeps.append(ms) })
    }
}

func signalStreamTest() {
    // statusesDecideReadStopOrRetry
    expect(SignalStream.decide(200) == .read, "200 reads")
    expect(SignalStream.decide(404) == .stop, "unknown device, or a cezar without the route")
    expect(SignalStream.decide(409) == .stop, "CEZ_PUSH=0")
    for status in [403, 500, 502, 503] { expect(SignalStream.decide(status) == .retry, "\(status) retries") }

    // signalsReachTheListenerWithAPlainManagerOnly
    do {
        let w = World()
        w.source.answers = [Script(200, ready, "event: signal\ndata: {\"managerId\":\"mgr_1\"}\n\n", "event: ping\ndata: \n\n",
                                   "event: signal\ndata: {}\n\n", "event: signal\ndata: {\"managerId\":\"../x\"}\n\n",
                                   "event: signal\ndata: not json\n\n", "event: surprise\ndata: {}\n\n")]
        w.wantedFor = 2
        expect(w.stream().run() == .noSession, "ends with the session")
        expect(w.signals == ["mgr_1", "null", "null"], "a plain manager only")
        expect(w.source.opened[0].closed, "closed")
        expect(!w.source.opened[0].badTimeout, "reads wait for the silence limit")
    }
    // notFoundAndConflictStopWithoutAnotherTry
    for status in [404, 409] {
        let w = World()
        w.source.answers = [Script(status), Script(200, ready)]
        expect(w.stream().run() == .refused, "\(status) refuses")
        expect(w.source.opened.count == 1, "\(status): one open")
        expect(w.source.opened[0].closed, "\(status): closed")
        expect(w.sleeps.isEmpty, "\(status): no wait, no retry")
    }
    // aRefusalKeepsEnsureRunningFromStartingAgain
    do {
        let w = World()
        w.source.answers = [Script(409)]
        let stream = w.stream()
        stream.ensureRunning { $0() }
        stream.ensureRunning { $0() }
        expect(w.source.opened.count == 1, "one open per view after a refusal")
    }
    // anEndedStreamReopensWithBackoffWhileTheSessionLasts
    do {
        let w = World()
        w.source.answers = [Offline(), Script(503), Script(200, ready), Script(200, ready, nil), Script(200)]
        w.wantedFor = 10
        expect(w.stream().run() == .noSession, "ends with the session")
        expect(w.source.opened.count == 4, "four opens")
        expect(w.source.opened[2].timedOut, "silence past three pings ends the stream")
        expect(w.sleeps.count == 5, "five waits")
        expect(w.sleeps.allSatisfy { $0 >= 1000 && $0 <= SignalStream.maxBackoffMs }, "waits in range")
        expect(w.sleeps.count == 5 && w.sleeps[1] <= 4000, "two failures grow the cap")
        expect(w.sleeps.count == 5 && w.sleeps[2] <= 2000 && w.sleeps[3] <= 2000, "a ready resets it")
    }
    // backoffIsCappedAtAMinute
    do {
        let stream = World().stream()
        expect((0..<40).allSatisfy { let d = stream.backoffMs($0); return d >= 1000 && d <= 60_000 }, "1 s to 60 s")
        expect(stream.backoffMs(0) <= 2000, "the first wait is at most 2 s")
    }
    // noSessionMeansNoOpen
    do {
        let w = World()
        w.wantedFor = 0
        w.source.answers = [Script(200, ready)]
        expect(w.stream().run() == .noSession, "no session")
        expect(w.source.opened.isEmpty, "no open")
    }
    // stopClosesTheOpenStreamAndEndsTheLoop
    do {
        let w = World()
        let script = StopOnRead(200, ready)
        w.source.answers = [script]
        let stream = w.stream()
        script.stream = stream
        expect(stream.run() == .stopped, "stopped")
        expect(script.closed, "the open stream closed")
        expect(w.sleeps.isEmpty, "no wait")
        var started = false
        stream.ensureRunning { _ in started = true }
        expect(!started, "a stopped stream never starts")
    }
    // aListenerThatThrowsDoesNotEndTheStream
    do {
        struct PostingFailed: Error {}
        let source = Scripted()
        source.answers = [Script(200, ready, "event: signal\ndata: {}\n\n", "event: signal\ndata: {}\n\n")]
        var calls = 0
        var asked = 0
        var sleeps: [Int64] = []
        let stream = SignalStream(source: source, wanted: { defer { asked += 1 }; return asked < 2 }, listener: { _ in
            calls += 1
            throw PostingFailed()
        }, random: { 0.5 }, sleeper: { sleeps.append($0) })
        expect(stream.run() == .noSession, "ends with the session")
        expect(calls == 2, "both signals reached the listener")
        expect(source.answers.isEmpty, "one open")
        expect(!sleeps.isEmpty, "then a wait")
    }
    // The production sleeper wakes at once on stop, and a no-session exit lets ensureRunning start again.
    do {
        let source = Scripted()
        var wanted = true
        let stream = SignalStream(source: source, wanted: { wanted }, listener: { _ in })
        let ended = DispatchSemaphore(value: 0)
        let began = Date()
        stream.ensureRunning { work in Thread { work(); ended.signal() }.start() }
        Thread.sleep(forTimeInterval: 0.1)
        stream.stop()
        expect(ended.wait(timeout: .now() + 5) == .success, "stop wakes the backoff wait")
        expect(Date().timeIntervalSince(began) < 2, "at once, not after the backoff")
        wanted = false
        let again = SignalStream(source: source, wanted: { wanted }, listener: { _ in })
        var runs = 0
        again.ensureRunning { runs += 1; $0() }
        again.ensureRunning { runs += 1; $0() }
        expect(runs == 2, "a no-session end does not block the next start")
    }
}
