import Foundation

/// The cockpit's static bundle for one relay server, so a cold start paints without the tunnel. Only the
/// shell (one per server, checked against the server's on every start) and Vite's hashed, immutable
/// `/assets/*`: never an API answer. App-private files, out of backups; Forget and Remove delete the directory.
final class BundleCache {
    enum Kind { case none, shell, asset }

    /// A cached answer: status 200 always, with the headers it came with.
    struct Entry {
        let headers: [TunnelFrame.Header]
        let body: [UInt8]

        func header(_ name: String) -> String? { headers.first { $0.name == name }?.value }
    }

    private static let FORMAT: UInt32 = 1
    private static let SHELL = "shell"
    private static let PATH = "path"
    /// A shell or bundle file past this is not the cockpit: it goes through uncached.
    static let MAX_ENTRY_BYTES = 8 * 1024 * 1024
    private static let KEPT: Set<String> = [
        "content-type", "cache-control", "etag", "last-modified",
        "content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy",
    ]

    private let directory: URL
    private let maxBytes: Int64
    /// Java's `synchronized`.
    private let lock = NSRecursiveLock()

    init(directory: URL, maxBytes: Int64) {
        self.directory = directory
        self.maxBytes = maxBytes
    }

    /// `/assets/<file>` by its path; any other page load is the SPA shell the server answers every route with.
    static func kindOf(method: String, target: String, fetchDest: String?, accept: String?) -> Kind {
        guard method == "GET" else { return .none }
        let path = pathOf(target)
        if path.hasPrefix("/assets/") && path.count > 8 && !path.dropFirst(8).contains("/") && !path.contains("..") { return .asset }
        if path == "/api" || path.hasPrefix("/api/") || path.hasPrefix("/assets/") { return .none }
        let document = fetchDest.map { $0 == "document" } ?? (accept?.contains("text/html") ?? false)
        return document ? .shell : .none
    }

    /// Whether this answer may be kept: a whole 200 that the server itself marks as static.
    static func storable(_ kind: Kind, status: Int, headers: [TunnelFrame.Header]) -> Bool {
        guard kind != .none, status == 200 else { return false }
        let type = headers.first { $0.name == "content-type" }?.value.lowercased()
        let cache = headers.first { $0.name == "cache-control" }?.value.lowercased()
        if cache?.contains("no-store") == true { return false }
        if kind == .asset { return cache?.contains("immutable") == true }
        return type?.hasPrefix("text/html") == true
    }

    func get(_ kind: Kind, _ target: String) -> Entry? {
        lock.lock()
        defer { lock.unlock() }
        guard let file = file(kind, target), let data = FileManager.default.contents(atPath: file.path) else { return nil }
        guard let entry = Self.decode([UInt8](data)) else {
            try? FileManager.default.removeItem(at: file)
            return nil
        }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return entry
    }

    func put(_ kind: Kind, _ target: String, headers: [TunnelFrame.Header], body: [UInt8]) {
        lock.lock()
        defer { lock.unlock() }
        guard let file = file(kind, target), body.count <= Self.MAX_ENTRY_BYTES, makeDirectory() else { return }
        let kept = headers.filter { Self.KEPT.contains($0.name) }
        do {
            try Data(Self.encode(kept, body)).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            return
        }
        trim()
    }

    /// The start path the last probed open chose (`/manager` or `/`), so the next one can skip the probe.
    func startPath() -> String? {
        get(.none, Self.PATH).map { String(decoding: $0.body, as: UTF8.self) }
    }

    func saveStartPath(_ path: String) {
        put(.none, Self.PATH, headers: [], body: Array(path.utf8))
    }

    /// A shell to paint from: what lets a start skip the probe.
    func hasShell() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let shell = file(.shell, "/") else { return false }
        return FileManager.default.fileExists(atPath: shell.path)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: directory)
    }

    /// Readable once the phone has been unlocked after a restart, as the prewarm needs; out of backups.
    private func makeDirectory() -> Bool {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) { return isDirectory.boolValue }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        } catch {
            return false
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = directory
        try? excluded.setResourceValues(values)
        return true
    }

    /// Oldest bundle files go first; the shell and the start path stay.
    private func trim() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
        var total: Int64 = 0
        var assets: [(url: URL, size: Int64, modified: Date)] = []
        for file in files {
            let values = try? file.resourceValues(forKeys: Set(keys))
            let size = Int64(values?.fileSize ?? 0)
            total += size
            if file.lastPathComponent.hasPrefix("a-") { assets.append((file, size, values?.contentModificationDate ?? .distantPast)) }
        }
        if total <= maxBytes { return }
        for asset in assets.sorted(by: { $0.modified < $1.modified }) {
            if total <= maxBytes { break }
            total -= asset.size
            try? FileManager.default.removeItem(at: asset.url)
        }
    }

    private func file(_ kind: Kind, _ target: String) -> URL? {
        switch kind {
        case .shell: return directory.appendingPathComponent(Self.SHELL)
        case .asset: return directory.appendingPathComponent("a-" + Bytes.hex(Array(RelayCrypto.sha256(Array(Self.pathOf(target).utf8)).prefix(16))))
        case .none: return target == Self.PATH ? directory.appendingPathComponent(Self.PATH) : nil
        }
    }

    private static func pathOf(_ target: String) -> String {
        String(target.prefix { $0 != "?" && $0 != "#" })
    }

    // Big-endian lengths: format, header count, then each name and value, then the body.
    private static func encode(_ headers: [TunnelFrame.Header], _ body: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        func u32(_ value: Int) { out += [UInt8(truncatingIfNeeded: value >> 24), UInt8(truncatingIfNeeded: value >> 16), UInt8(truncatingIfNeeded: value >> 8), UInt8(truncatingIfNeeded: value)] }
        u32(Int(FORMAT))
        u32(headers.count)
        for header in headers {
            for text in [header.name, header.value] {
                let bytes = Array(text.utf8)
                u32(bytes.count)
                out += bytes
            }
        }
        u32(body.count)
        out += body
        return out
    }

    /// Nil for anything that is not a whole entry: a damaged file is a miss, never a crash.
    private static func decode(_ bytes: [UInt8]) -> Entry? {
        var at = 0
        func u32() -> Int? {
            guard at + 4 <= bytes.count else { return nil }
            let value = Int(bytes[at]) << 24 | Int(bytes[at + 1]) << 16 | Int(bytes[at + 2]) << 8 | Int(bytes[at + 3])
            at += 4
            return value
        }
        func chunk(max: Int) -> [UInt8]? {
            guard let length = u32(), length <= max, at + length <= bytes.count else { return nil }
            defer { at += length }
            return Array(bytes[at..<at + length])
        }
        guard u32() == Int(FORMAT), let count = u32(), count <= 64 else { return nil }
        var headers: [TunnelFrame.Header] = []
        for _ in 0..<count {
            guard let name = chunk(max: 65536), let value = chunk(max: 65536) else { return nil }
            headers.append(TunnelFrame.Header(name: String(decoding: name, as: UTF8.self), value: String(decoding: value, as: UTF8.self)))
        }
        guard let body = chunk(max: MAX_ENTRY_BYTES), at == bytes.count else { return nil }
        return Entry(headers: headers, body: body)
    }

    /// Collects a body as it streams by, giving up past the entry cap.
    final class Capture {
        private var collected: [UInt8] = []
        private var overflow = false

        func add(_ data: [UInt8]) {
            if overflow { return }
            if collected.count + data.count > BundleCache.MAX_ENTRY_BYTES {
                overflow = true
                collected = []
                return
            }
            collected += data
        }

        func bytes() -> [UInt8]? { overflow ? nil : collected }
    }
}
