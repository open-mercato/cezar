import Foundation

/// A phone's keys for one server: fresh per server, so two cezars cannot correlate it (§ 2).
struct DeviceKeys: Equatable {
    let ed25519Seed: [UInt8]
    let x25519Secret: [UInt8]

    static func generate() -> DeviceKeys {
        DeviceKeys(ed25519Seed: RelayCrypto.random(32), x25519Secret: RelayCrypto.x25519Secret())
    }

    func relayKey() -> [UInt8] { RelayCrypto.ed25519Public(ed25519Seed) }
    func deviceId() -> String { RelayIds.id(relayKey()) }

    func toBytes() -> [UInt8] { ed25519Seed + x25519Secret }

    static func fromBytes(_ bytes: [UInt8]) -> DeviceKeys? {
        guard bytes.count == 64 else { return nil }
        return DeviceKeys(ed25519Seed: Array(bytes[0..<32]), x25519Secret: Array(bytes[32..<64]))
    }
}
