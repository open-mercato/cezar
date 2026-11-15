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
}
