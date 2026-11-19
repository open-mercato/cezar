import Foundation

/// What pairing pinned for a relay server. It has no URL and no password (spec "What changes in #1883").
struct RelayFields: Codable, Equatable {
    let origin: String
    let cezarId: String
    /// cezar's X25519 key, base64url.
    let cezarKey: String
    let deviceId: String
    /// Saved per server, so its origin keeps storage and HTTP cache across launches. 0 before the first bind.
    var port: Int

    func withPort(_ value: Int) -> RelayFields {
        var copy = self
        copy.port = value
        return copy
    }
}
