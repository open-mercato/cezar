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

// Automatic identity: the spec's golden vectors, byte-identical with the cockpit and Android
let golden: [(String, String, String)] = [
    ("Studio iMac", "#7c6cf0", "SI"), ("Build box", "#22b3a0", "BB"), ("MacBook Pro", "#2a9fd8", "MP"),
    ("Home server", "#e05a73", "HS"), ("patryk-mbp", "#2a9fd8", "P"), ("Żółw", "#e0912a", "Ż"), ("a", "#e0912a", "A"),
    ("Mac 🍎 mini", "#e05a73", "MM"), ("🍎", "#e05a73", ""),
]
for (name, color, initials) in golden {
    expect(DeviceIdentity.color(name) == color, "\(name) colour \(DeviceIdentity.color(name))")
    expect(DeviceIdentity.initials(name) == initials, "\(name) initials \(DeviceIdentity.initials(name))")
}
expect(DeviceIdentity.color("  Studio iMac \n") == "#7c6cf0" && DeviceIdentity.initials("  studio   imac ") == "SI", "trimmed, runs of spaces")
expect(DeviceIdentity.initials("") == "" && DeviceIdentity.initials("one two three") == "OT", "empty, first two words")

// Health: the optional counts
func health(_ body: String) -> HealthAnswer {
    HealthClassifier.classify(HttpAnswer(status: 200, headers: ["content-type": "application/json"], body: body))
}
let base = #"{"version":"1.0.0","capabilities":{}"#
expect(health(base + #","attention":{"waiting":2,"failed":1}}"#).attention == HealthAnswer.Attention(waiting: 2, failed: 1), "counts read")
expect(health(base + "}").attention == nil && health(base + "}").kind == .cezar, "absent is unknown")
for odd in [#"{"waiting":2}"#, #"{"waiting":-1,"failed":0}"#, #"{"waiting":1.5,"failed":0}"#, #"{"waiting":"2","failed":0}"#,
            #"{"waiting":true,"failed":0}"#, "3", "null"] {
    expect(health(base + #","attention":"# + odd + "}").attention == nil, "odd counts are unknown: \(odd)")
}
expect(HealthAnswer.Attention(waiting: 2, failed: 1).need == 3, "need is waiting plus failed")

// Statuses: a relay link's kind
expect(DeviceSwitch.status(RelayStatus.Kind.ready) == .online, "a live session is online")
for kind: RelayStatus.Kind in [.idle, .connecting] { expect(DeviceSwitch.status(kind) == .checking, "\(kind) is still checking") }
for kind: RelayStatus.Kind in [.relayDown, .cezarOffline, .notAnswering] { expect(DeviceSwitch.status(kind) == .offline, "\(kind) is offline") }
expect(DeviceSwitch.status(RelayStatus.Kind.emailUnconfirmed) == .other("Email not confirmed"), "email words")
expect(DeviceSwitch.status(RelayStatus.Kind.suspended) == .other("Suspended"), "suspended words")
expect(DeviceSwitch.status(RelayStatus.Kind.broken) == .other("Can't connect"), "broken words")

// Statuses: a direct server's health
expect(DeviceSwitch.status(HealthAnswer.Kind.cezar) == .online, "health answered")
for kind: HealthAnswer.Kind in [.unreachable, .relayDown] { expect(DeviceSwitch.status(kind) == .offline, "\(kind) is offline") }
for kind: HealthAnswer.Kind in [.tlsFailure, .notCezar, .localMode] { expect(DeviceSwitch.status(kind) == .other("Can't connect"), "\(kind) can't connect") }
expect(DeviceSwitch.status(HealthAnswer.Kind.basicGate) == .other("Sign in needed"), "a gate asks to sign in")

// Words: "Offline since" the last time it was online
var utc = Calendar(identifier: .gregorian)
utc.timeZone = TimeZone(identifier: "UTC")!
let gb = Locale(identifier: "en_GB")
let noon: Int64 = 1_763_208_000_000 // 2025-11-15 12:00 UTC
let at1402: Int64 = noon + (2 * 60 + 2) * 60_000
expect(DeviceSwitch.words(.offline, seenAt: noon, now: at1402, calendar: utc, locale: gb) == "Offline since 12:00", "same day: the time")
expect(DeviceSwitch.words(.offline, seenAt: noon - 3 * 86_400_000, now: at1402, calendar: utc, locale: gb) == "Offline since 12 Nov",
       "another day: the date, \(DeviceSwitch.words(.offline, seenAt: noon - 3 * 86_400_000, now: at1402, calendar: utc, locale: gb))")
expect(DeviceSwitch.words(.offline, seenAt: nil, now: at1402) == "Offline", "never seen")
expect(DeviceSwitch.words(.online, seenAt: nil, now: 0) == "Online" && DeviceSwitch.words(.checking, seenAt: nil, now: 0) == "Checking…", "plain words")

// Rows: current first, then online, offline, the rest; by need inside each
let relayServer = ServerRecord(id: "r", label: "Patryk's MacBook Pro", url: nil,
                               relay: RelayFields(origin: "https://relay.example.test", cezarId: "c", cezarKey: "k", deviceId: "d", port: 0))
let directServer = ServerRecord(id: "d", label: "Box", url: "https://box.example.com:8443")
let here = ServerRecord(id: "h", label: "Studio", url: "https://studio.example.com")
let quiet = ServerRecord(id: "q", label: "Quiet", url: "https://quiet.example.com")
let gone = ServerRecord(id: "g", label: "Gone", url: "https://gone.example.com")
var book = DeviceBook()
book.sync([relayServer, here, directServer, quiet, gone])
book.noted("q", online: true, waiting: 4, failed: 0, at: noon)
let rows = DeviceSwitch.rows([gone, relayServer, here, directServer, quiet], currentId: "h",
                             readings: ["r": .init(.online, attention: .init(waiting: 1, failed: 0)), "d": .init(.online, attention: .init(waiting: 2, failed: 3)),
                                        "q": .init(.offline), "g": .init(.other("Suspended")), "h": .init(.offline, attention: .init(waiting: 9, failed: 9))],
                             book: book, now: at1402, calendar: utc, locale: gb)
expect(rows.map(\.id) == ["h", "d", "r", "q", "g"], "spec order: \(rows.map(\.id))")
expect(rows[0].current && rows[0].status == .online && rows[0].words == "Online" && rows[0].needWords == nil, "the page on screen is online and ticked")
expect(rows[1].needWords == "5 need you" && rows[2].needWords == "1 needs you", "need words")
expect(rows[3].words == "Offline since 12:00" && rows[3].needWords == "4 need you", "offline keeps its last count and last-seen time")
expect(rows[4].words == "Suspended" && rows[4].needWords == nil, "no count is no words")
expect(rows[2].initials == "PM" && rows[2].color == DeviceIdentity.color("Patryk's MacBook Pro"), "the avatar")
expect(rows[2].accessibilityLabel == "Patryk's MacBook Pro, Online, 1 needs you", "reads label, status and count: \(rows[2].accessibilityLabel)")
expect(rows[0].accessibilityLabel == "Studio, Online, current", "reads current")
expect(rows[2].switchingLabel == "Patryk's MacBook Pro, switching", "reads switching while it opens")
let one = DeviceSwitch.rows([here], currentId: "h", readings: [:], book: DeviceBook(), now: 0)
expect(one.count == 1 && one[0].current && one[0].words == "Online", "one computer: one ticked row")
expect(DeviceSwitch.rows([directServer], currentId: "h", readings: [:], book: DeviceBook(), now: 0)[0].status == .checking, "not reported yet is checking")

// The book: sync, counts, the badge, naming a push
do {
    var book = DeviceBook()
    book.sync([relayServer, here])
    expect(book.entries["r"]?.cezarId == "c" && book.entries["h"]?.cezarId == nil && book.entries["r"]?.name == "Patryk's MacBook Pro", "names and relay ids")
    expect(book.badge == 0 && book.entries["r"]?.need == nil, "unknown counts")
    book.noted("h", online: true, waiting: 2, failed: 5, at: 10)
    book.noted("h", online: false, waiting: nil, failed: nil, at: 20)
    expect(book.entries["h"]?.seenAt == 10 && book.entries["h"]?.need == 7, "offline keeps the last-seen time and counts")
    expect(book.badge == 2, "the badge sums waiting")
    var renamed = relayServer
    renamed.label = "Laptop"
    book.sync([renamed, here])
    expect(book.entries["r"]?.name == "Laptop" && book.entries["h"]?.waiting == 2, "a rename keeps the counts")
    let named = PushNaming.named(cezarId: "c", badge: 3, book: &book)
    expect(named?.title == "Laptop" && named?.body == "Needs you" && named?.badge == 5, "a push names its computer and sums the badge")
    expect(book.entries["r"]?.waiting == 3, "the push's count is kept")
    expect(PushNaming.named(cezarId: "unknown", badge: 1, book: &book) == nil && PushNaming.named(cezarId: nil, badge: 1, book: &book) == nil,
           "an unknown cezar keeps the relay's words")
    expect(PushNaming.named(cezarId: "c", badge: nil, book: &book)?.badge == 5, "no count keeps the last one")
    book.sync([here])
    expect(book.entries["r"] == nil && book.badge == 2, "a forgotten computer leaves the badge")
}

do {
    final class Memory: DeviceBookStorage {
        var data: Data?
        var writes = 0
        func read() -> Data? { data }
        func write(_ data: Data) { self.data = data; writes += 1 }
    }
    let memory = Memory()
    let store = DeviceBookStore(storage: memory)
    store.update { $0.sync([relayServer]) }
    store.update { $0.sync([relayServer]) }
    expect(memory.writes == 1 && store.load().entries["r"]?.name == "Patryk's MacBook Pro", "written once, read back")
    memory.data = Data("not json".utf8)
    expect(store.load() == DeviceBook(), "unreadable is empty")
}

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
    var reports: [String: (DeviceSwitch.Reading) -> Void] = [:]
    var released: [String] = []
    var changes: [String] = []
    let probes = DeviceProbes(relay: { server, report in reports[server.id] = report },
                              direct: { server, report in reports[server.id] = report },
                              release: { released.append($0.id) }, schedule: manual.schedule,
                              onChange: { id, reading in changes.append("\(id) \(reading.status) \(reading.attention?.need ?? -1)") })
    probes.start([relayServer, here, directServer], currentId: "h")
    expect(Set(reports.keys) == ["r", "d", "h"], "every server is read, the page on screen for its counts")
    expect(manual.delays == [DeviceProbes.boundMs] && DeviceProbes.boundMs == 6000, "bounded at 6 s")
    expect(probes.status("r") == .checking && probes.status("h") == .checking, "checking until a report")
    reports["r"]!(.init(.online))
    reports["r"]!(.init(.online))
    expect(changes == ["r online -1"], "a change is told once")
    reports["r"]!(.init(.online, attention: .init(waiting: 2, failed: 0)))
    reports["r"]!(.init(.online))
    expect(changes == ["r online -1", "r online 2"] && probes.snapshot()["r"]?.attention?.need == 2, "counts arrive, and outlive a status-only report")
    manual.fire()
    expect(probes.status("d") == .offline && changes.last == "d offline -1", "not known by the bound is offline")
    reports["d"]!(.init(.checking))
    expect(probes.status("d") == .offline, "a late connecting does not undo offline")
    reports["d"]!(.init(.other("Sign in needed")))
    expect(probes.status("d") == .other("Sign in needed"), "a late answer still turns the row")
    reports["r"]!(.init(.other("Suspended")))
    expect(probes.status("r") == .other("Suspended") && probes.snapshot()["r"]?.attention == nil, "live: a link that moves on is told")
    probes.stop(keep: "r")
    expect(released == ["d"], "closing releases every warm link but the switch's target, never the current server's")
    reports["d"]!(.init(.online))
    expect(probes.status("d") == .other("Sign in needed"), "nothing after the sheet closed")
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
    DeviceProbes.relayProbe(connections, userAgent: "ua")(server) { reading in seen.value.append(reading.status) }
    expect(eventually { seen.value.contains(.offline) }, "a relay that is down reads offline: \(seen.value)")
    expect(connections.warming("r") && transport.dials.value >= 1, "probing dialled the switcher's own link")
    connections.releaseWarm("r")
    expect(!connections.warming("r"), "released")

    let unpaired = ServerRecord(id: "x", label: "Gone", url: nil, relay: server.relay)
    let none = Locked<DeviceSwitch.Status?>(nil)
    DeviceProbes.relayProbe(connections, userAgent: "ua")(unpaired) { none.value = $0.status }
    expect(eventually { none.value == .other("Removed from this computer") }, "no device keys read as removed")
    connections.release()
}

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
