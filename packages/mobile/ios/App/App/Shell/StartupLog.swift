import Foundation

/// What the last starts and connections did, step by step, for the user to copy from Your cezars
/// (Android's StartupLog). Steps, timings, relay states, reason and close codes only: never a key, a
/// cookie, an id, a path or page content.
final class StartupLog {
    static let maxLines = 300

    private let file: URL?
    private let clock: () -> Int64
    private let lock = NSLock()
    private var lines: [String] = []
    private var startedAt: Int64 = 0
    private var loaded = false

    init(file: URL?, clock: @escaping () -> Int64) {
        self.file = file
        self.clock = clock
    }

    /// A new start: later lines carry their offset from it.
    func begin(_ what: String) {
        lock.lock()
        defer { lock.unlock() }
        startedAt = clock()
        add("── " + Self.stamp(startedAt) + " " + what)
    }

    func step(_ what: String) {
        lock.lock()
        defer { lock.unlock() }
        add("+\(clock() - startedAt)ms " + what)
    }

    func text() -> String {
        lock.lock()
        defer { lock.unlock() }
        load()
        return lines.map { $0 + "\n" }.joined()
    }

    private func add(_ line: String) {
        load()
        lines.append(line.replacingOccurrences(of: "\n", with: " "))
        if lines.count > Self.maxLines { lines.removeFirst(lines.count - Self.maxLines) }
        save()
    }

    private func load() {
        if loaded { return }
        loaded = true
        guard let file, let data = try? Data(contentsOf: file) else { return }
        // A lost log costs nothing but the log.
        lines = String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init) + lines
        if lines.count > Self.maxLines { lines.removeFirst(lines.count - Self.maxLines) }
    }

    private func save() {
        guard let file else { return }
        try? Data(lines.map { $0 + "\n" }.joined().utf8).write(to: file, options: .atomic)
    }

    private static func stamp(_ millis: Int64) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(identifier: "UTC")
        format.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        return format.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }
}
