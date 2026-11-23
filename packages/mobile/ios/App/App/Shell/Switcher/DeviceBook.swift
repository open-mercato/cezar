import Foundation

/// What the phone last knew of each saved computer: its name, its relay id, its counts and when it was
/// last online. Shared with the Notification Service Extension, which names a push from it and sums
/// the badge. Never leaves the phone (switcher spec "Push"). Also compiled into the extension: Foundation only.
struct DeviceBook: Codable, Equatable {
    struct Entry: Codable, Equatable {
        var name: String
        /// A relay computer's cezar id, the `s` of its pushes.
        var cezarId: String?
        /// Nil until a health answer or a push said: unknown, never zero.
        var waiting: Int?
        var failed: Int?
        /// Epoch ms of the last answer that read online.
        var seenAt: Int64?

        var need: Int? {
            guard waiting != nil || failed != nil else { return nil }
            return (waiting ?? 0) + (failed ?? 0)
        }
    }

    /// By server id.
    var entries: [String: Entry] = [:]

    /// The app-icon badge: what waits for the user on every computer, as last known.
    var badge: Int { entries.values.reduce(0) { $0 + max(0, $1.waiting ?? 0) } }

    /// The relay computers whose count is known to be 0: their delivered notifications go (spec 2026-11-20-phone-notifications-inbox, B3).
    var settled: Set<String> {
        Set(entries.values.compactMap { entry in entry.waiting == 0 ? entry.cezarId.flatMap { $0.isEmpty ? nil : $0 } : nil })
    }

    /// The delivered notifications of `settled` computers, by request id. A relay push is matched by its `s`, a local
    /// one by its id, which is the cezar id too.
    static func toRemove(_ delivered: [(id: String, cezarId: String?)], settled: Set<String>) -> [String] {
        delivered.filter { settled.contains($0.cezarId ?? $0.id) }.map(\.id)
    }

    func entry(cezarId: String?) -> Entry? {
        guard let cezarId, !cezarId.isEmpty else { return nil }
        return entries.values.first { $0.cezarId == cezarId }
    }

    /// A health answer from this computer. `online` stamps the last-seen time; nil counts keep the last ones.
    mutating func noted(_ id: String, online: Bool, waiting: Int?, failed: Int?, at now: Int64) {
        guard var entry = entries[id] else { return }
        if online { entry.seenAt = now }
        if let waiting, let failed {
            entry.waiting = waiting
            entry.failed = failed
        }
        entries[id] = entry
    }

    /// A push for this cezar carries its own count of what waits. False for a cezar the phone does not know.
    @discardableResult
    mutating func pushed(cezarId: String?, waiting: Int?) -> Bool {
        guard let cezarId, !cezarId.isEmpty, let id = entries.first(where: { $0.value.cezarId == cezarId })?.key else { return false }
        if let waiting, waiting >= 0 { entries[id]?.waiting = waiting }
        return true
    }
}

/// The words of a push once the phone knows which computer sent it. The relay's stay generic (§ 7).
enum PushNaming {
    static let body = "Needs you"

    /// Title, body and badge for a push whose `s` is `cezarId` with the relay's `badge`, or nil for an
    /// unknown cezar, which keeps the relay's own words. `book` takes the push's count.
    static func named(cezarId: String?, badge: Int?, book: inout DeviceBook) -> (title: String, body: String, badge: Int)? {
        guard book.pushed(cezarId: cezarId, waiting: badge), let entry = book.entry(cezarId: cezarId) else { return nil }
        let name = entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return (name.isEmpty ? "Cezar" : name, body, book.badge)
    }
}

/// Where the book is kept. The app and the extension each hold one.
protocol DeviceBookStorage {
    func read() -> Data?
    func write(_ data: Data)
}

/// Read-modify-write over the storage. Unreadable reads as an empty book: never a failure.
final class DeviceBookStore {
    private let storage: DeviceBookStorage
    private let lock = NSLock()

    init(storage: DeviceBookStorage) {
        self.storage = storage
    }

    func load() -> DeviceBook {
        lock.lock()
        defer { lock.unlock() }
        return read()
    }

    @discardableResult
    func update<T>(_ change: (inout DeviceBook) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        var book = read()
        let before = book
        let result = change(&book)
        if book != before, let data = try? JSONEncoder().encode(book) { storage.write(data) }
        return result
    }

    private func read() -> DeviceBook {
        guard let data = storage.read(), let book = try? JSONDecoder().decode(DeviceBook.self, from: data) else { return DeviceBook() }
        return book
    }
}
