import Foundation

extension DeviceBook {
    /// Follows the saved list: names and relay ids as they are now, a forgotten computer's counts gone.
    mutating func sync(_ servers: [ServerRecord]) {
        var next: [String: Entry] = [:]
        for server in servers {
            var entry = entries[server.id] ?? Entry(name: server.label)
            entry.name = server.label
            entry.cezarId = server.relay?.cezarId
            next[server.id] = entry
        }
        entries = next
    }

    /// A probe's reading: online stamps the last-seen time, told counts replace the last ones.
    mutating func noted(_ id: String, _ reading: DeviceSwitch.Reading, at now: Int64) {
        noted(id, online: reading.status == .online, waiting: reading.attention?.waiting, failed: reading.attention?.failed, at: now)
    }
}
