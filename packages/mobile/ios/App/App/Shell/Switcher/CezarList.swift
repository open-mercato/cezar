import Foundation

/// The connect page's Your cezars list: what a listed row adds from the switcher, the rename rule and
/// the version line (spec 2026-11-19-mobile-devices-screen, "Native ↔ page contract"). Android has the same.
enum CezarList {
    static let maxLabel = 60

    enum Rename: Equatable {
        case saved(String)
        case refused(String)
    }

    /// The switcher's fields for one row: avatar, status, its words, why it is blocked, and its count.
    static func fields(_ row: DeviceSwitch.Row) -> [String: Any] {
        var fields: [String: Any] = ["initials": row.initials, "color": row.color, "status": row.status.key, "words": row.words,
                                     "need": row.need.map { $0 as Any } ?? NSNull()]
        if let reason = row.status.reason { fields["reason"] = reason }
        return fields
    }

    /// Trimmed, 1–60 characters, for a cezar this phone still has.
    static func rename(_ label: String?, known: Bool) -> Rename {
        guard known else { return .refused("This cezar is no longer on this phone.") }
        let name = (label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return .refused("Enter a name.") }
        if name.count > maxLabel { return .refused("Use \(maxLabel) characters or fewer.") }
        return .saved(name)
    }

    /// "0.1.1 (87)", or the short version alone when the build is unknown.
    static func version(short: String?, build: String?) -> String {
        let short = short.flatMap { $0.isEmpty ? nil : $0 } ?? "0"
        guard let build, !build.isEmpty, build != short else { return short }
        return "\(short) (\(build))"
    }
}

/// The page's `probe`: `DeviceProbes` once over every saved cezar, done when all answered or at the bound,
/// each reading noted in the book as the switcher does, then the warm links let go. The readings outlive
/// it, so the next listed outcome carries them. A probe while one runs joins it.
final class CezarProbe {
    typealias Make = (@escaping (String, DeviceSwitch.Reading) -> Void) -> DeviceProbes

    private let make: Make
    private let book: DeviceBookStore
    private let clock: () -> Int64
    private let onBadge: (Int) -> Void
    private let lock = NSLock()
    private var running: DeviceProbes?
    private var waiters: [() -> Void] = []
    private var readings: [String: DeviceSwitch.Reading] = [:]
    private var currentId: String?

    /// `onBadge`: the icon's sum, when a reading told counts.
    init(make: @escaping Make, book: DeviceBookStore, clock: @escaping () -> Int64, onBadge: @escaping (Int) -> Void = { _ in }) {
        self.make = make
        self.book = book
        self.clock = clock
        self.onBadge = onBadge
    }

    /// `done` runs once, on any thread.
    func probe(_ servers: [ServerRecord], currentId: String?, done: @escaping () -> Void) {
        lock.lock()
        if running != nil {
            waiters.append(done)
            lock.unlock()
            return
        }
        waiters = [done]
        self.currentId = currentId
        let probes = make { [weak self] id, reading in self?.changed(id, reading) }
        running = probes
        lock.unlock()
        let now = clock()
        book.update { book in
            book.sync(servers)
            if let currentId { book.noted(currentId, online: true, waiting: nil, failed: nil, at: now) }
        }
        probes.start(servers, currentId: currentId)
        finishIfAnswered()
    }

    /// The rows the page draws, in the switcher's order, from the last finished probe.
    func rows(_ servers: [ServerRecord], now: Int64) -> [DeviceSwitch.Row] {
        lock.lock()
        let readings = self.readings
        let currentId = self.currentId
        lock.unlock()
        return DeviceSwitch.rows(servers, currentId: currentId, readings: readings, book: book.load(), now: now)
    }

    private func changed(_ id: String, _ reading: DeviceSwitch.Reading) {
        let now = clock()
        book.update { book in book.noted(id, reading, at: now) }
        if reading.attention != nil { onBadge(book.load().badge) }
        finishIfAnswered()
    }

    private func finishIfAnswered() {
        lock.lock()
        guard let probes = running else {
            lock.unlock()
            return
        }
        let snapshot = probes.snapshot()
        guard !snapshot.values.contains(where: { $0.status == .checking }) else {
            lock.unlock()
            return
        }
        readings = snapshot
        running = nil
        let done = waiters
        waiters = []
        lock.unlock()
        probes.stop()
        done.forEach { $0() }
    }
}
