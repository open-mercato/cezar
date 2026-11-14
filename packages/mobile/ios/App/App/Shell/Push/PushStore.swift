import Foundation

/// Push state as one JSON file under Application Support, excluded from backup. Unreadable means empty: push off, nothing owed.
final class PushStore {
    /// A write failed (disk full, a read-only directory). Java's IllegalStateException.
    struct Unsaved: Error {}

    /// One server's switch and grant.
    struct Server: Equatable {
        let enabled: Bool
        /// cezar may hold a grant from this phone, so turning the switch off owes it a `DELETE`.
        let held: Bool
        let grant: PushGrant?

        static let off = Server(enabled: false, held: false, grant: nil)
    }

    /// A grant still to be denied at the relay (§ 7). `forgotten`: its server is gone, and its device key waits for this.
    struct Revoke: Equatable {
        let serverId: String
        let label: String
        let origin: String
        let grant: String
        let expiresAt: Int64
        let notBefore: Int64
        let attempts: Int
        let forgotten: Bool

        func retryAt(_ when: Int64) -> Revoke {
            Revoke(serverId: serverId, label: label, origin: origin, grant: grant, expiresAt: expiresAt, notBefore: when,
                   attempts: attempts + 1, forgotten: forgotten)
        }

        func markedForgotten() -> Revoke {
            Revoke(serverId: serverId, label: label, origin: origin, grant: grant, expiresAt: expiresAt, notBefore: notBefore,
                   attempts: attempts, forgotten: true)
        }
    }

    private let directory: URL
    private let file: URL
    private let lock = NSRecursiveLock()

    init(directory: URL) {
        self.directory = directory
        file = directory.appendingPathComponent("push.json")
    }

    /// The app's: `Application Support/push`, never in an iCloud or iTunes backup (a grant names this device's token).
    static func defaultDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        var directory = base.appendingPathComponent("push", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
        return directory
    }

    func asked() -> Bool { locked { PushJson.bool(read(), "asked") } }

    func setAsked() throws {
        try locked {
            var root = read()
            root["asked"] = true
            try write(root)
        }
    }

    func server(_ id: String) -> Server {
        locked {
            guard let servers = read()["servers"] as? [String: Any], let row = servers[id] as? [String: Any] else { return .off }
            let grant = (row["grant"] as? [String: Any]).flatMap(Self.grantOf)
            return Server(enabled: PushJson.bool(row, "enabled"), held: PushJson.bool(row, "held"), grant: grant)
        }
    }

    func putServer(_ id: String, _ server: Server) throws {
        try locked {
            var root = read()
            var servers = root["servers"] as? [String: Any] ?? [:]
            var row: [String: Any] = ["enabled": server.enabled, "held": server.held]
            if let g = server.grant {
                row["grant"] = ["grant": g.grant, "grantId": g.grantId, "expiresAt": g.expiresAt, "cezarKey": g.cezarKey, "handedOver": g.handedOver]
            }
            servers[id] = row
            root["servers"] = servers
            try write(root)
        }
    }

    func removeServer(_ id: String) throws {
        try locked {
            var root = read()
            guard var servers = root["servers"] as? [String: Any] else { return }
            servers[id] = nil
            root["servers"] = servers
            root["renew"] = Self.without(root["renew"], id)
            try write(root)
        }
    }

    /// APNs gave a new token: this server's grant names a dead one until a new grant is got. Never the token itself.
    func setRenew(_ id: String, _ owed: Bool) throws {
        try locked {
            var root = read()
            var rest = Self.without(root["renew"], id)
            if owed { rest.append(id) }
            root["renew"] = rest
            try write(root)
        }
    }

    func renewOwed(_ id: String) -> Bool {
        locked { (read()["renew"] as? [Any] ?? []).contains { ($0 as? String) == id } }
    }

    func revokes() -> [Revoke] {
        locked {
            let rows = read()["revokes"] as? [Any] ?? []
            return rows.compactMap { item -> Revoke? in
                guard let row = item as? [String: Any], let grant = PushJson.text(row, "grant"), !grant.isEmpty,
                      let origin = PushJson.text(row, "origin"), !origin.isEmpty else { return nil }
                return Revoke(serverId: PushJson.text(row, "serverId") ?? "", label: PushJson.text(row, "label") ?? "", origin: origin,
                              grant: grant, expiresAt: PushJson.long(row, "expiresAt"), notBefore: PushJson.long(row, "notBefore"),
                              attempts: Int(PushJson.long(row, "attempts")), forgotten: PushJson.bool(row, "forgotten"))
            }
        }
    }

    func setRevokes(_ revokes: [Revoke]) throws {
        try locked {
            var root = read()
            root["revokes"] = revokes.map { r -> [String: Any] in
                ["serverId": r.serverId, "label": r.label, "origin": r.origin, "grant": r.grant, "expiresAt": r.expiresAt,
                 "notBefore": r.notBefore, "attempts": r.attempts, "forgotten": r.forgotten]
            }
            try write(root)
        }
    }

    /// Server ids with state, for a token change.
    func serverIds() -> [String] {
        locked { Array((read()["servers"] as? [String: Any] ?? [:]).keys) }
    }

    private static func without(_ rows: Any?, _ id: String) -> [String] {
        (rows as? [Any] ?? []).compactMap { $0 as? String }.filter { $0 != id }
    }

    private static func grantOf(_ row: [String: Any]) -> PushGrant? {
        guard let grant = PushJson.text(row, "grant"), !grant.isEmpty, let grantId = PushJson.text(row, "grantId"), !grantId.isEmpty,
              let cezarKey = PushJson.text(row, "cezarKey"), !cezarKey.isEmpty else { return nil }
        return PushGrant(grant: grant, grantId: grantId, expiresAt: PushJson.long(row, "expiresAt"), cezarKey: cezarKey,
                         handedOver: PushJson.bool(row, "handedOver"))
    }

    private func locked<T>(_ work: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try work()
    }

    private func read() -> [String: Any] {
        guard let data = try? Data(contentsOf: file),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return root
    }

    /// Temp file then rename, like the Java: a crash mid-write leaves the old state, never half of it.
    private func write(_ root: [String: Any]) throws {
        guard let data = try? JSONSerialization.data(withJSONObject: root) else { throw Unsaved() }
        let tmp = directory.appendingPathComponent("push.json.tmp")
        do {
            try data.write(to: tmp)
        } catch {
            throw Unsaved()
        }
        guard rename(tmp.path, file.path) == 0 else { throw Unsaved() }
    }
}
