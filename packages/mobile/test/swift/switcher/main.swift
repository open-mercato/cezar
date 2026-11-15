// The device switcher's plain classes on macOS: statuses, rows, and the probes behind the sheet.
import Foundation

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () -> Bool, _ name: String, line: Int = #line) {
    checks += 1
    if !condition() {
        failures += 1
        print("FAIL line \(line): \(name)")
    }
}

func eventually(_ ms: Int = 3000, _ condition: () -> Bool) -> Bool {
    let deadline = Date(timeIntervalSinceNow: Double(ms) / 1000)
    while Date() < deadline {
        if condition() { return true }
        Thread.sleep(forTimeInterval: 0.005)
    }
    return condition()
}

final class MemoryKeys: DeviceKeyStore {
    private let lock = NSLock()
    private var items: [String: [UInt8]] = [:]
    func put(_ id: String, _ keys: DeviceKeys) throws {
        lock.lock()
        items[id] = keys.toBytes()
        lock.unlock()
    }
    func get(_ id: String) -> DeviceKeys? {
        lock.lock()
        defer { lock.unlock() }
        return items[id].flatMap(DeviceKeys.fromBytes)
    }
    func delete(_ id: String) {
        lock.lock()
        items[id] = nil
        lock.unlock()
    }
}

/// Every dial fails at once, as a relay that is down.
final class DownTransport: SocketTransport {
    final class Dead: SocketConnection {
        func sendText(_ text: String) -> Bool { false }
        func sendBinary(_ bytes: [UInt8]) -> Bool { false }
        func close(_ code: Int) {}
    }
    let dials = Locked(0)
    func connect(url: String, headers: [(String, String)], events: SocketEvents) -> SocketConnection {
        dials.value += 1
        DispatchQueue.global().async { events.failed(status: 0, code: nil, retryAfterSeconds: -1, dateMillis: -1) }
        return Dead()
    }
}

let relayServer = ServerRecord(id: "r", label: "Patryk's MacBook Pro", url: nil,
                               relay: RelayFields(origin: "https://relay.example.test", cezarId: "c", cezarKey: "k", deviceId: "d", port: 0))
let directServer = ServerRecord(id: "d", label: "Box", url: "https://box.example.com:8443")
let here = ServerRecord(id: "h", label: "Studio", url: "https://studio.example.com")

// Statuses: a relay link's kind
expect(DeviceSwitch.status(RelayStatus.Kind.ready) == .connected, "a live session is connected")
for kind: RelayStatus.Kind in [.idle, .connecting] { expect(DeviceSwitch.status(kind) == .checking, "\(kind) is still checking") }
for kind: RelayStatus.Kind in [.emailUnconfirmed, .accountRequired, .updateApp, .updateCezar] {
    expect(DeviceSwitch.status(kind) == .attention, "\(kind) needs attention")
}
for kind: RelayStatus.Kind in [.suspended, .termsRequiredDevice, .deviceRemoved] { expect(DeviceSwitch.status(kind) == .blocked, "\(kind) is blocked") }
for kind: RelayStatus.Kind in [.relayDown, .cezarOffline, .notAnswering, .quota, .broken] { expect(DeviceSwitch.status(kind) == .offline, "\(kind) is offline") }

// Statuses: a direct server's health
expect(DeviceSwitch.status(HealthAnswer.Kind.cezar) == .connected, "health answered")
for kind: HealthAnswer.Kind in [.basicGate, .loginPage, .localMode, .updateCezar, .updateApp] {
    expect(DeviceSwitch.status(kind) == .attention, "\(kind) needs attention")
}
for kind: HealthAnswer.Kind in [.unreachable, .tlsFailure, .notCezar, .relayDown] { expect(DeviceSwitch.status(kind) == .offline, "\(kind) is offline") }
for kind: HealthAnswer.Kind in [.suspended, .termsRequiredDevice, .deviceRemoved] { expect(DeviceSwitch.status(kind) == .blocked, "\(kind) is blocked") }

// Rows: list order, second line, tick, what VoiceOver reads
let rows = DeviceSwitch.rows([relayServer, here, directServer], currentId: "h", statuses: ["r": .offline])
expect(rows.map(\.id) == ["r", "h", "d"], "list order")
expect(rows[0].detail == "Through the relay" && rows[2].detail == "box.example.com", "relay and host second lines")
expect(rows[1].current && !rows[0].current && rows[1].status == .connected, "the current one is ticked and connected")
expect(rows[2].status == .checking, "not reported yet is checking")
expect(rows[0].accessibilityLabel == "Patryk's MacBook Pro, offline", "reads label and status")
expect(rows[1].accessibilityLabel == "Studio, connected, current", "reads current")
expect(rows[0].switchingLabel == "Patryk's MacBook Pro, switching", "reads switching while it opens")
expect(DeviceSwitch.rows([here], currentId: "h", statuses: ["h": .blocked])[0].status == .connected, "the page on screen is connected")
expect(DeviceSwitch.Status.attention.words == "needs attention" && DeviceSwitch.Status.blocked.words == "blocked", "words")

// DeviceProbes: one probe per server not on screen, live updates, the bound, release on close
final class Manual {
    var pending: [() -> Void] = []
    var delays: [Int] = []
    func schedule(_ ms: Int, _ work: @escaping () -> Void) {
        delays.append(ms)
        pending.append(work)
    }
    func fire() {
        let all = pending
        pending = []
        all.forEach { $0() }
    }
}

do {
    let manual = Manual()
    var reports: [String: (DeviceSwitch.Status) -> Void] = [:]
    var released: [String] = []
    var changes: [String] = []
    let probes = DeviceProbes(relay: { server, report in reports[server.id] = report },
                              direct: { server, report in reports[server.id] = report },
                              release: { released.append($0.id) }, schedule: manual.schedule,
                              onChange: { id, status in changes.append("\(id) \(status.words)") })
    probes.start([relayServer, here, directServer], currentId: "h")
    expect(Set(reports.keys) == ["r", "d"], "the page on screen is not probed")
    expect(manual.delays == [DeviceProbes.boundMs] && DeviceProbes.boundMs == 6000, "bounded at 6 s")
    expect(probes.status("r") == .checking && probes.status("h") == nil, "checking until a report")
    reports["r"]!(.connected)
    reports["r"]!(.connected)
    expect(changes == ["r connected"], "a change is told once")
    manual.fire()
    expect(probes.status("d") == .offline && changes.last == "d offline", "not known by the bound is offline")
    reports["d"]!(.checking)
    expect(probes.status("d") == .offline, "a late connecting does not undo offline")
    reports["d"]!(.attention)
    expect(probes.status("d") == .attention, "a late answer still turns the dot")
    reports["r"]!(.blocked)
    expect(probes.status("r") == .blocked, "live: a link that moves on is told")
    probes.stop(keep: "r")
    expect(released == ["d"], "closing releases every warm link but the switch's target")
    reports["d"]!(.connected)
    expect(probes.status("d") == .attention, "nothing after the sheet closed")
    probes.stop()
    expect(released == ["d"], "stop is once")
}

do {
    let manual = Manual()
    var released: [String] = []
    let probes = DeviceProbes(relay: { _, _ in }, direct: { _, _ in }, release: { released.append($0.id) }, schedule: manual.schedule,
                              onChange: { _, _ in })
    probes.start([relayServer, directServer], currentId: "d")
    probes.stop()
    expect(released == ["r"], "closing without a switch releases all it probed, never the current server")
    manual.fire()
    expect(probes.status("r") == .checking, "the bound after close changes nothing")
}

// The relay probe through a real RelayConnections: its own link, the page on screen untouched.
do {
    let keys = MemoryKeys()
    let transport = DownTransport()
    let connections = RelayConnections(transport: transport, keys: keys, userAgent: "ua")
    let device = DeviceKeys.generate()
    try! keys.put("r", device)
    let pinned = Bytes.base64url(RelayCrypto.x25519Public(RelayCrypto.x25519Secret()))
    let server = ServerRecord(id: "r", label: "Laptop", url: nil,
                              relay: RelayFields(origin: "https://relay.example.test", cezarId: "cezar-id", cezarKey: pinned, deviceId: device.deviceId(), port: 0))
    let seen = Locked<[DeviceSwitch.Status]>([])
    DeviceProbes.relayProbe(connections)(server) { status in seen.value.append(status) }
    expect(eventually { seen.value.contains(.offline) }, "a relay that is down reads offline: \(seen.value)")
    expect(connections.warming("r") && transport.dials.value >= 1, "probing dialled the switcher's own link")
    connections.releaseWarm("r")
    expect(!connections.warming("r"), "released")

    let unpaired = ServerRecord(id: "x", label: "Gone", url: nil, relay: server.relay)
    let none = Locked<DeviceSwitch.Status?>(nil)
    DeviceProbes.relayProbe(connections)(unpaired) { none.value = $0 }
    expect(eventually { none.value == .blocked }, "no device keys read as removed: blocked")
    connections.release()
}

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
