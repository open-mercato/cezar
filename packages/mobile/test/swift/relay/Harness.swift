import Foundation

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () throws -> Bool, _ name: String, line: Int = #line, file: String = #fileID) {
    checks += 1
    if (try? condition()) != true {
        failures += 1
        print("FAIL \(file):\(line): \(name)")
    }
}

/// Runs `body`, counting a thrown error as one failure.
func test(_ name: String, _ body: () throws -> Void) {
    do {
        try body()
    } catch {
        checks += 1
        failures += 1
        print("FAIL \(name): threw \(error)")
    }
}

func throwsError(_ body: () throws -> Void) -> Bool {
    do {
        try body()
        return false
    } catch {
        return true
    }
}

func vectors(_ name: String) -> [String: Any] {
    let url = URL(fileURLWithPath: "../../test-vectors/relay/\(name)")
    return try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
}

func hex(_ text: Any?) -> [UInt8] { Bytes.fromHex(text as! String)! }
func hex(_ bytes: [UInt8]) -> String { Bytes.hex(bytes) }
func rows(_ value: Any?) -> [[String: Any]] { value as! [[String: Any]] }
func str(_ row: [String: Any], _ key: String) -> String { row[key] as! String }
func num(_ row: [String: Any], _ key: String) -> Int { (row[key] as! NSNumber).intValue }

/// Waits until `condition` holds, up to `ms`.
func eventually(_ ms: Int = 2000, _ condition: () -> Bool) -> Bool {
    let deadline = Date(timeIntervalSinceNow: Double(ms) / 1000)
    while Date() < deadline {
        if condition() { return true }
        Thread.sleep(forTimeInterval: 0.005)
    }
    return condition()
}

/// The vectors' ephemerals, injected only here: the shipped code has no fixed source (vectors README).
struct FixedEphemeral: NoiseEphemerals {
    let secret: [UInt8]
    func next() -> [UInt8] { secret }
}

func vectorHandshake(_ pattern: String, initiator: Bool, prologue: [UInt8], staticSecret: [UInt8], remoteStatic: [UInt8]?, psk: [UInt8]?,
                     ephemeral: [UInt8]) -> NoiseHandshake {
    NoiseHandshake(pattern: pattern, initiator: initiator, prologue: prologue, staticSecret: staticSecret, remoteStatic: remoteStatic, psk: psk,
                   ephemerals: FixedEphemeral(secret: ephemeral))
}

func text(_ bytes: [UInt8]) -> String { String(decoding: bytes, as: UTF8.self) }

/// An in-memory `DeviceKeyStore`, the tests' stand-in for the Keychain.
final class MemoryKeys: DeviceKeyStore {
    private let lock = NSLock()
    private var items: [String: [UInt8]] = [:]
    var failPuts = false

    func put(_ id: String, _ keys: DeviceKeys) throws {
        lock.lock()
        defer { lock.unlock() }
        if failPuts { throw RelayIOError("disk full") }
        items[id] = keys.toBytes()
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

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return items.count
    }
}
