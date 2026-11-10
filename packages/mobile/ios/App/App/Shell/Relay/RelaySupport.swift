import Foundation

/// The few JDK pieces the Java relay classes lean on, in Foundation terms: a whole-string regex
/// match, `LinkedBlockingQueue.poll`, and org.json's lenient readers.
enum RelayRegex {
    /// Groups of a match over the WHOLE text (Java's `matches()`), nil when it does not match.
    /// `\A`/`\z` anchors, never `^`/`$`, which would let a trailing newline through.
    static func groups(_ pattern: String, _ text: String, dotAll: Bool = false) -> [String?]? {
        guard let regex = try? NSRegularExpression(pattern: "\\A(?:\(pattern))\\z", options: dotAll ? [.dotMatchesLineSeparators] : []) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            Range(match.range(at: index), in: text).map { String(text[$0]) }
        }
    }

    static func matches(_ pattern: String, _ text: String) -> Bool { groups(pattern, text) != nil }
}

/// `LinkedBlockingQueue`: `add` never blocks, `poll` waits up to a timeout.
final class BlockingQueue<T> {
    private let condition = NSCondition()
    private var items: [T] = []

    func add(_ item: T) {
        condition.lock()
        items.append(item)
        condition.broadcast()
        condition.unlock()
    }

    /// Nil after `timeoutMs` with nothing queued.
    func poll(timeoutMs: Int64) -> T? {
        let deadline = Date(timeIntervalSinceNow: Double(max(0, timeoutMs)) / 1000)
        condition.lock()
        defer { condition.unlock() }
        while items.isEmpty {
            if !condition.wait(until: deadline) { break }
        }
        return items.isEmpty ? nil : items.removeFirst()
    }

    func clear() {
        condition.lock()
        items.removeAll()
        condition.unlock()
    }

    var isEmpty: Bool {
        condition.lock()
        defer { condition.unlock() }
        return items.isEmpty
    }
}

/// org.json's `optString`/`optInt`/`optLong`: absent or of another shape reads as the default.
enum RelayJson {
    static func object(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func object(_ bytes: [UInt8]) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: Data(bytes))) as? [String: Any]
    }

    static func string(_ json: [String: Any]?, _ key: String) -> String {
        guard let value = json?[key] else { return "" }
        if let text = value as? String { return text }
        if value is NSNull { return "" }
        if let number = value as? NSNumber { return number.stringValue }
        return ""
    }

    static func int64(_ json: [String: Any]?, _ key: String, _ fallback: Int64) -> Int64 {
        guard let value = json?[key] else { return fallback }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let double = number.doubleValue
            return double.isFinite && abs(double) < 9.2e18 ? Int64(double) : fallback
        }
        if let text = value as? String, let parsed = Int64(text) { return parsed }
        return fallback
    }

    static func int(_ json: [String: Any]?, _ key: String, _ fallback: Int) -> Int {
        let value = int64(json, key, Int64(fallback))
        return value >= Int64(Int32.min) && value <= Int64(Int32.max) ? Int(value) : fallback
    }

    /// `getInt`: throws when absent or not a number.
    static func requiredInt(_ json: [String: Any]?, _ key: String) throws -> Int {
        guard let number = json?[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw Missing(key: key) }
        let double = number.doubleValue
        guard double.isFinite, double >= Double(Int32.min), double <= Double(Int32.max) else { throw Missing(key: key) }
        return Int(double)
    }

    struct Missing: Error {
        let key: String
    }

    static func string(of object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// An I/O failure with no more to say: the Java classes' `IOException`.
struct RelayIOError: Error, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
}

/// A relay-sent wait in seconds, as milliseconds. A hostile value must not trap on overflow (security
/// review F2): it is capped at a day, longer than any wait in RELAY_PROTOCOL.md.
func relayWaitMs(_ seconds: Int64) -> Int64 { min(max(seconds, 0), maxRelayWaitSeconds) * 1000 }
let maxRelayWaitSeconds: Int64 = 86_400

/// Milliseconds since 1970, the Java classes' `System.currentTimeMillis`.
func relayNowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// A Java `volatile`: one value read and written under a lock.
final class Locked<T> {
    private let lock = NSLock()
    private var stored: T

    init(_ value: T) { stored = value }

    var value: T {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}

/// A single-thread `ScheduledExecutorService`: every event runs on one serial queue, so a state
/// machine on it needs no locks. After `shutdown()` nothing posted or scheduled runs.
final class RelayActor {
    private let queue: DispatchQueue
    private let closed = Locked(false)

    init(label: String) {
        queue = DispatchQueue(label: label)
    }

    func execute(_ work: @escaping () -> Void) {
        if closed.value { return }
        queue.async { [closed] in
            if !closed.value { work() }
        }
    }

    func schedule(afterMs delayMs: Int64, _ work: @escaping () -> Void) {
        if closed.value { return }
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(clamping: max(0, delayMs)))) { [closed] in
            if !closed.value { work() }
        }
    }

    func shutdown() { closed.value = true }

    var isShutdown: Bool { closed.value }
}
