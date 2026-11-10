import Foundation

/// One saved server. The password is never here: it lives in `CredentialStore` under `id`.
struct ServerRecord: Codable, Equatable {
    let id: String
    var label: String
    let url: String
    var username: String?
    /// The realm the password was saved for; nil on a server with no Basic gate.
    var realm: String?
    /// Which one-time note this server has shown.
    var noteShown: String?

    var origin: ServerOrigin? { try? ServerOrigin.parse(url) }
}

/// The server list as one JSON file. Unreadable means empty: state is never a boot failure.
final class ServerListStore {
    private struct Saved: Codable {
        var servers: [ServerRecord] = []
        var lastUsedId: String?
    }

    private let file: URL
    private let lock = NSLock()

    init(directory: URL) {
        file = directory.appendingPathComponent("servers.json")
    }

    func list() -> [ServerRecord] { locked { read().servers } }
    func get(_ id: String) -> ServerRecord? { list().first { $0.id == id } }
    func find(url: String) -> ServerRecord? { list().first { $0.url == url } }
    func lastUsedId() -> String? { locked { read().lastUsedId } }

    func put(_ server: ServerRecord) {
        locked {
            var saved = read()
            if let index = saved.servers.firstIndex(where: { $0.id == server.id }) {
                saved.servers[index] = server
            } else {
                saved.servers.append(server)
            }
            write(saved)
        }
    }

    func remove(_ id: String) {
        locked {
            var saved = read()
            saved.servers.removeAll { $0.id == id }
            if saved.lastUsedId == id { saved.lastUsedId = nil }
            write(saved)
        }
    }

    func markUsed(_ id: String) {
        locked {
            var saved = read()
            saved.lastUsedId = id
            write(saved)
        }
    }

    private func locked<T>(_ work: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return work()
    }

    private func read() -> Saved {
        guard let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return Saved() }
        return saved
    }

    private func write(_ saved: Saved) {
        guard let data = try? JSONEncoder().encode(saved) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}
