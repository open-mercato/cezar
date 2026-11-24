import Foundation

/// CezarPushTest.
func cezarPushTest() {
    // putSendsExactlyTheContractsThreeFields
    do {
        let cezar = FakeCezar()
        let state = try? cezar.api().put(PushGrant(grant: "sealed", grantId: grantIdFixture, expiresAt: 1_807_776_000, cezarKey: cezarKeyFixture, handedOver: false))
        expect(state?.grantId == grantIdFixture, "put answers cezar's state")
        let body = PushJson.object(cezar.bodies[0]) ?? [:]
        expect(body.count == 3, "exactly three fields")
        expect(body["grant"] as? String == "sealed", "grant")
        expect(PushJson.long(body, "expiresAt") == 1_807_776_000, "expiresAt")
        expect(cezar.calls[0] == "PUT /api/v1/workspace/phone/push", "PUT path")
    }
    // a409MeansPushIsOffAtCezar
    do {
        let cezar = FakeCezar()
        cezar.available = false
        var refused = false
        do { refused = try cezar.api().put(PushGrant(grant: "g", grantId: grantIdFixture, expiresAt: 1, cezarKey: cezarKeyFixture, handedOver: false)) == nil } catch {}
        expect(refused, "409 is nil")
        expect((try? cezar.api().get())?.available == false, "get reads off")
    }
    // anOldCezarWithNoRouteReadsAsOff
    do {
        let api = CezarPush(http: { _, _, _, _ in HttpAnswer(status: 404, headers: [:], body: "{}") }, userAgent: "ua")
        expect((try? api.get())?.available == false, "404 reads as off")
        expect(!throwsError { try api.delete() }, "404 delete is fine")
        let broken = CezarPush(http: { _, _, _, _ in HttpAnswer(status: 500, headers: [:], body: "") }, userAgent: "ua")
        expect(throwsError { _ = try broken.get() } && throwsError { try broken.delete() }, "500 throws")
    }
    // aKeyThatIsNotThirtyTwoBytesReadsAsOff
    do {
        expect((try? CezarPush.State.parse("{\"available\":true,\"cezarKey\":\"short\"}"))?.available == false, "short key off")
        let ok = try? CezarPush.State.parse("{\"available\":true,\"cezarKey\":\"\(cezarKeyFixture)\",\"managerId\":\"m1\",\"extra\":1}")
        expect(ok?.available == true, "a real key is on")
        expect(ok?.managerId == "m1", "managerId")
        let numeric = try? CezarPush.State.parse("{\"available\":true,\"cezarKey\":\"\(cezarKeyFixture)\",\"managerId\":7}")
        expect(numeric != nil && numeric!.managerId == nil, "a non-string managerId is nil")
        expect(throwsError { _ = try CezarPush.State.parse("[]") }, "not an object throws")
    }
}

/// ForegroundServersTest.
func foregroundServersTest() {
    do {
        let servers = ForegroundServers()
        expect(servers.shouldNotify("a"), "nothing on screen")
        servers.started("a")
        expect(!servers.shouldNotify("a"), "on screen is silent")
        expect(servers.shouldNotify("b"), "another server still notifies")
        servers.stopped("a")
        expect(servers.shouldNotify("a"), "in the grace window the page is off screen")
    }
    do {
        let servers = ForegroundServers()
        servers.started("a")
        servers.started("a")
        servers.stopped("a")
        expect(!servers.shouldNotify("a"), "two views stay foreground until both stop")
        servers.stopped("a")
        servers.stopped("a")
        expect(servers.shouldNotify("a"), "both stopped")
    }
    do {
        let servers = ForegroundServers()
        servers.started(nil)
        servers.stopped(nil)
        expect(!servers.shouldNotify(nil), "no server id never notifies")
    }
}

/// GraceCloseTest: a main-thread handler on a fake clock.
final class FakeScheduler: GraceClose.Scheduler {
    final class Task: GraceClose.Scheduled {
        let due: Int64
        let run: () -> Void
        weak var owner: FakeScheduler?
        init(_ due: Int64, _ run: @escaping () -> Void, _ owner: FakeScheduler) {
            self.due = due
            self.run = run
            self.owner = owner
        }
        func cancel() { owner?.tasks.removeAll { $0 === self } }
    }

    var tasks: [Task] = []
    var now: Int64 = 0

    func schedule(_ task: @escaping () -> Void, delayMs: Int64) -> GraceClose.Scheduled {
        let scheduled = Task(now + delayMs, task, self)
        tasks.append(scheduled)
        return scheduled
    }

    func advance(_ ms: Int64) {
        now += ms
        let due = tasks.filter { $0.due <= now }
        tasks.removeAll { $0.due <= now }
        for task in due { task.run() }
    }
}

func graceCloseTest() {
    func world() -> (FakeScheduler, GraceClose, () -> Int) {
        let clock = FakeScheduler()
        var closes = 0
        let grace = GraceClose(scheduler: clock) { closes += 1 }
        return (clock, grace, { closes })
    }
    do {
        let (clock, grace, closes) = world()
        expect(grace.started(), "first start opens")
        grace.stopped()
        expect(grace.pending(), "pending after stop")
        clock.advance(GraceClose.graceMs - 1)
        expect(closes() == 0, "still open inside the window")
        clock.advance(1)
        expect(closes() == 1, "closed at 30 s")
        expect(!grace.pending(), "no longer pending")
        clock.advance(GraceClose.graceMs * 4)
        expect(closes() == 1, "once per stop")
        expect(grace.started(), "a start after the close must start the link again")
    }
    do {
        let (clock, grace, closes) = world()
        grace.started()
        grace.stopped()
        clock.advance(20_000)
        expect(!grace.started(), "the socket never closed")
        expect(!grace.pending(), "start cancels")
        clock.advance(GraceClose.graceMs * 2)
        expect(closes() == 0, "no close after a restart")
        grace.stopped()
        clock.advance(GraceClose.graceMs)
        expect(closes() == 1, "the second stop gets its own full window")
    }
    do {
        let (clock, grace, closes) = world()
        grace.started()
        grace.stopped()
        clock.advance(10_000)
        grace.stopped()
        clock.advance(20_000)
        expect(closes() == 1, "a second stop does not extend the window")
        expect(clock.tasks.isEmpty, "nothing left scheduled")
    }
    do {
        let (clock, grace, closes) = world()
        grace.stopped()
        expect(!grace.pending(), "a stop before any start")
        grace.started()
        grace.stopped()
        grace.cancel()
        clock.advance(GraceClose.graceMs * 2)
        expect(closes() == 0, "the destroyed view's link goes with it, not by this timer")
        expect(clock.tasks.isEmpty, "cancel unschedules")
    }
}

/// RenewalPolicyTest.
func renewalPolicyTest() {
    let now: Int64 = 1_800_000_000
    let day: Int64 = 24 * 60 * 60
    func cezar(_ grantId: String?) -> CezarPush.State {
        CezarPush.State(available: true, cezarKey: cezarKeyFixture, grantId: grantId, grantExpiresAt: 0, managerId: nil)
    }
    func grant(_ daysLeft: Int64, _ handedOver: Bool) -> PushGrant {
        PushGrant(grant: "sealed", grantId: grantIdFixture, expiresAt: now + daysLeft * day, cezarKey: cezarKeyFixture, handedOver: handedOver)
    }
    let other = "BBBBBBBBBBBBBBBBBBBBBB"
    expect(RenewalPolicy.decide(nil, cezar(nil), nowSeconds: now) == .obtain, "no grant gets one")
    expect(RenewalPolicy.decide(grant(60, true), cezar(grantIdFixture), nowSeconds: now) == .none, "held, 60 days")
    expect(RenewalPolicy.decide(grant(30, true), cezar(grantIdFixture), nowSeconds: now) == .none, "held, 30 days")
    expect(RenewalPolicy.decide(grant(29, true), cezar(grantIdFixture), nowSeconds: now) == .obtain, "under 30 days renews")
    expect(RenewalPolicy.decide(grant(-1, true), cezar(grantIdFixture), nowSeconds: now) == .obtain, "expired renews")
    expect(RenewalPolicy.decide(grant(60, true), cezar(nil), nowSeconds: now) == .obtain, "cezar holding none renews")
    expect(RenewalPolicy.decide(grant(60, true), cezar(other), nowSeconds: now) == .obtain, "cezar holding another renews")
    expect(RenewalPolicy.decide(grant(60, false), cezar(nil), nowSeconds: now) == .handOver, "never had: hand over")
    expect(RenewalPolicy.decide(grant(60, false), cezar(other), nowSeconds: now) == .handOver, "never had, other: hand over")
    expect(RenewalPolicy.decide(grant(60, true), cezar(grantIdFixture), nowSeconds: now, tokenChanged: true) == .obtain, "a new token renews")
    let otherKey = PushGrant(grant: "sealed", grantId: grantIdFixture, expiresAt: now + 60 * day, cezarKey: "other", handedOver: true)
    expect(RenewalPolicy.decide(otherKey, cezar(grantIdFixture), nowSeconds: now) == .obtain, "a grant for another cezar key renews")
}

/// SignalParserTest.
func signalParserTest() {
    var events: [String] = []
    var parser = SignalParser { type, data in events.append(type + "|" + data) }
    func feed(_ text: String) { parser.feed(Bytes.utf8(text)) }

    feed("event: ready\ndata: {}\n\n")
    feed("event: signal\ndata: {\"managerId\":\"mgr_1\"}\n\n")
    feed("event: signal\ndata: {}\n\n")
    feed("event: ping\ndata: \n\n")
    expect(events == ["ready|{}", "signal|{\"managerId\":\"mgr_1\"}", "signal|{}", "ping|"], "ready, signal and ping as cezar sends them")

    events = []
    feed(": keep-alive\n\nid: 7\nretry: 1000\nevent: signal\n: in the middle\ndata: {}\n\n")
    expect(events == ["signal|{}"], "comments and unknown fields are ignored")

    let wire = Bytes.utf8("event: ready\r\ndata: {}\r\n\r\nevent: signal\rdata: {\"managerId\":\"é\"}\r\revent: ping\ndata:\n\n")
    var allSizes = true
    for size in 1...wire.count {
        var split: [String] = []
        let pieces = SignalParser { type, data in split.append(type + "|" + data) }
        var at = 0
        while at < wire.count {
            pieces.feed(wire, offset: at, length: min(size, wire.count - at))
            at += size
        }
        if split != ["ready|{}", "signal|{\"managerId\":\"é\"}", "ping|"] {
            allSizes = false
            print("pieces of \(size): \(split)")
        }
    }
    expect(allSizes, "any piece size and line ending gives the same events")

    events = []
    parser = SignalParser { type, data in events.append(type + "|" + data) }
    feed("event: signal\ndata: {}")
    expect(events.isEmpty, "no blank line yet")
    feed("\n\n\n\n")
    expect(events == ["signal|{}"], "blank lines alone are nothing")
    events = []
    feed("garbage\n{\"managerId\":\"x\"}\n\n")
    expect(events.isEmpty, "unknown fields make no event")
    feed("event: signal\ndata: " + String(repeating: "x", count: SignalParser.maxLine + 10) + "\n\nevent: signal\ndata: {}\n\n")
    expect(events == ["signal|{}"], "an overlong line spoils only its own event")

    events = []
    feed("event: signal\ndata: {\ndata: }\n\n")
    expect(events == ["signal|{\n}"], "multiple data lines join with newlines")
}
