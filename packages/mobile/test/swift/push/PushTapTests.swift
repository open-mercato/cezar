import Foundation

/// PushTapTest: a tap carries a cezarId only; the manager comes from cezar inside the session (spec R5).
private let cezarId = "cezarcezarcezarcezar01"
private let relayFields = RelayFields(origin: "https://relay.example.test", cezarId: cezarId, cezarKey: "x25519", deviceId: "device", port: 0)
private let relayRecord = ServerRecord(id: "r", label: "Laptop", url: nil, relay: relayFields)
private let manualRecord = ServerRecord(id: "m", label: "Box", url: "https://box.example.com")

/// The connector's open, scripted: the relay open is the sibling task's, so the outcome is what it will return.
private final class FakeConnector: PushTap.Connector {
    var servers = [manualRecord, relayRecord]
    var outcome = ShellConnector.Outcome(screen: ShellConnector.connectionError, serverId: "r")
    var calls: [String] = []

    func list() -> [ServerRecord] { servers }

    func open(_ id: String, cookies: String?) async -> ShellConnector.Outcome {
        calls.append("open \(id)")
        return outcome
    }
}

private final class Scripted: HttpGet {
    var answers: [HttpAnswer] = []
    func get(url: String, headers: [String: String]) async throws -> HttpAnswer {
        if answers.isEmpty { throw URLError(.notConnectedToInternet) }
        return answers.removeFirst()
    }
}

private final class NoPasswords: CredentialStore {
    func put(_ id: String, password: String) {}
    func get(_ id: String) -> String? { nil }
    func delete(_ id: String) {}
}

func pushTapTest() {
    // theCezarIdFindsItsRelayServer
    expect(PushTap.serverFor(cezarId, [manualRecord, relayRecord])?.id == "r", "the cezarId finds its relay server")
    expect(PushTap.serverFor("cezarcezarcezarcezar02", [manualRecord, relayRecord]) == nil, "another cezarId")
    expect(PushTap.serverFor(nil, [relayRecord]) == nil, "no id")
    expect(PushTap.serverFor(cezarId + "/../x", [relayRecord]) == nil, "a malformed id matches nothing")

    // onlyAPlainManagerIdIsFollowed
    expect(PushTap.landing("/manager", "mgr_1-a") == "/manager/mgr_1-a", "a plain manager")
    for bad in [nil, "", "../settings", "a/b", "a?b", "a b", "%2e%2e", String(repeating: "x", count: 65), "é"] as [String?] {
        expect(PushTap.landing("/manager", bad) == "/manager", "refuses \(String(describing: bad))")
    }
    expect(PushTap.landing("/", "mgr") == "/", "a root start stays at the root")

    // anOfferedTapIsTakenOnceAndAMalformedOneNever
    PushTap.offer(cezarId)
    let tap = PushTap.take()
    expect(tap?.cezarId == cezarId && tap?.managerId == nil, "taken")
    expect(PushTap.take() == nil, "once")
    PushTap.offer("javascript:alert(1)")
    expect(PushTap.take() == nil, "a malformed one never")

    // aLocalTapsManagerIsKeptOnlyWhenPlain
    PushTap.offer(cezarId, "mgr_1")
    expect(PushTap.take()?.managerId == "mgr_1", "a plain manager is kept")
    PushTap.offer(cezarId, "../settings")
    let dropped = PushTap.take()
    expect(dropped?.cezarId == cezarId && dropped?.managerId == nil, "a malformed manager drops to cezar's answer")
    PushTap.offer("bad id", "mgr_1")
    expect(PushTap.take() == nil, "a bad id drops the whole tap")

    // The payloads both kinds of notification carry.
    expect(PushPayload.local(cezarId: cezarId, managerId: "mgr_1") == ["s": cezarId, "m": "mgr_1"], "local payload")
    expect(PushPayload.local(cezarId: cezarId, managerId: "../x") == ["s": cezarId], "a bad manager never rides")
    PushPayload.offerTap(["aps": ["alert": ["title": "Cezar"]], "s": cezarId])
    expect(PushTap.take() == PushTap.Tap(cezarId: cezarId, managerId: nil), "a relay APNs tap")
    PushPayload.offerTap(["s": cezarId, "m": "mgr2"])
    expect(PushTap.take() == PushTap.Tap(cezarId: cezarId, managerId: "mgr2"), "a local tap")
    PushPayload.offerTap(["s": 7])
    expect(PushTap.take() == nil, "a non-string id")
    let foreground = ForegroundServers()
    expect(PushPayload.shouldShow(cezarId: cezarId, servers: [relayRecord], foreground: foreground, enabled: { _ in true }), "shown")
    expect(!PushPayload.shouldShow(cezarId: cezarId, servers: [relayRecord], foreground: foreground, enabled: { _ in false }), "not after the switch went off")
    expect(!PushPayload.shouldShow(cezarId: cezarId, servers: [manualRecord], foreground: foreground, enabled: { _ in true }), "not for a forgotten server")
    foreground.started("r")
    expect(!PushPayload.shouldShow(cezarId: cezarId, servers: [relayRecord], foreground: foreground, enabled: { _ in true }), "not over its own page")

    let opened = ShellConnector.Outcome(screen: ShellConnector.open, serverId: "r", url: "http://127.0.0.1:49152/manager")
    // aLocalTapsManagerLandsWithoutAskingCezar
    do {
        let connector = FakeConnector()
        connector.outcome = opened
        PushTap.offer(cezarId, "mgr2")
        let taken = PushTap.take()!
        var asked = false
        let outcome = blocking { await PushTap.open(connector, taken) { _ in asked = true; return "other" } }
        expect(outcome?.url == "http://127.0.0.1:49152/manager/mgr2", "the signal named the manager")
        expect(!asked, "cezar not asked")
        PushTap.offer(cezarId, nil)
        let plain = PushTap.take()!
        expect(blocking { await PushTap.open(connector, plain) { _ in "mgr1" } }?.url == "http://127.0.0.1:49152/manager/mgr1", "cezar's answer")
    }
    // aTapOpensThroughTheNormalOpenAndLandsOnTheManager
    do {
        let connector = FakeConnector()
        connector.outcome = opened
        let outcome = blocking { await PushTap.open(connector, cezarId) { _ in "mgr1" } }
        expect(outcome?.screen == ShellConnector.open && outcome?.url == "http://127.0.0.1:49152/manager/mgr1", "lands on the manager")
        expect(connector.calls == ["open r"], "through the normal open")
        expect(blocking { await PushTap.open(connector, cezarId) { _ in nil } }?.url == "http://127.0.0.1:49152/manager", "no manager: the start")
        connector.outcome = ShellConnector.Outcome(screen: ShellConnector.open, serverId: "r", url: "http://127.0.0.1:49152/")
        expect(blocking { await PushTap.open(connector, cezarId) { _ in "mgr1" } }?.url == "http://127.0.0.1:49152/", "a root start stays")
        connector.outcome = ShellConnector.Outcome(screen: ShellConnector.open, serverId: "r", url: "http://127.0.0.1:49152/x/manager")
        expect(blocking { await PushTap.open(connector, cezarId) { _ in "mgr1" } }?.url == "http://127.0.0.1:49152/x/manager", "only a bare /manager")
    }
    // aServerThatCannotOpenShowsItsScreenAndAsksNothing
    do {
        let connector = FakeConnector()
        var asked = false
        let outcome = blocking { await PushTap.open(connector, cezarId) { _ in asked = true; return "m" } }
        expect(outcome?.screen == ShellConnector.connectionError && !asked, "its screen, no question")
    }
    // anUnknownCezarIdOpensNothing
    do {
        let connector = FakeConnector()
        expect(blocking { await PushTap.open(connector, "cezarcezarcezarcezar02") { _ in "m" } } == nil, "nil")
        expect(connector.calls.isEmpty, "no open")
    }
    // The real ShellConnector satisfies PushTap.Connector; a relay row opens through its RelayPort, at a path.
    do {
        final class UpRelay: ShellConnector.RelayPort {
            func probe(_ server: ServerRecord) async -> HealthAnswer { HealthAnswer(kind: .cezar, status: 200, version: "1", managers: true) }
            func goodbye(_ server: ServerRecord) {}
            func forgetKeys(_ id: String) {}
        }
        let directory = temporaryDirectory()
        let servers = ServerListStore(directory: directory)
        servers.put(ServerRecord(id: "r", label: "Laptop", url: nil, relay: relayFields))
        let connector = ShellConnector(servers: servers, credentials: NoPasswords(), probe: HealthProbe(http: Scripted(), userAgent: "ua"),
                                       relay: UpRelay())
        let outcome = blocking { await PushTap.open(connector, cezarId) { _ in "mgr1" } }
        expect(outcome?.url == "/manager/mgr1", "ShellConnector.withUrl on a relay path")
    }
}

extension PushTap.Tap: CustomStringConvertible {
    public var description: String { "\(cezarId)/\(managerId ?? "-")" }
}

extension ShellConnector.Outcome: Equatable {
    public static func == (a: Self, b: Self) -> Bool { a.screen == b.screen && a.url == b.url && a.serverId == b.serverId }
}
