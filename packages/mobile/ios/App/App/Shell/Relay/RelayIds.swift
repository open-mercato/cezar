import Foundation

/// Self-certifying ids and relay proofs (RELAY_PROTOCOL.md §§ 2, 3.1).
enum RelayIds {
    private static let idLabel = Bytes.ascii("cezar-relay-id-v1\n")

    static func idBytes(_ ed25519Public: [UInt8]) -> [UInt8] {
        Array(RelayCrypto.sha256(idLabel, ed25519Public).prefix(16))
    }

    static func id(_ ed25519Public: [UInt8]) -> String { Bytes.base64url(idBytes(ed25519Public)) }

    static func socketProof(role: String, roomId: String, deviceId: String, time: Int64) -> String {
        "cezar-relay-v1\n\(role)\n\(roomId)\n\(deviceId)\n\(time)"
    }

    static func postProof(path: String, body: [UInt8], time: Int64) -> String {
        "cezar-relay-post-v1\n\(path)\n\(Bytes.hex(RelayCrypto.sha256(body)))\n-\n\(time)"
    }

    static func sign(_ ed25519Seed: [UInt8], _ proof: String) -> String {
        Bytes.base64url(RelayCrypto.ed25519Sign(ed25519Seed, Bytes.utf8(proof)))
    }

    /// The three proof headers for a phone socket, in this order.
    static func phoneHeaders(_ ed25519Seed: [UInt8], cezarId: String, deviceId: String, time: Int64) -> [(String, String)] {
        [("X-Cezar-Relay-Key", Bytes.base64url(RelayCrypto.ed25519Public(ed25519Seed))),
         ("X-Cezar-Relay-Time", String(time)),
         ("X-Cezar-Relay-Sig", sign(ed25519Seed, socketProof(role: "phone", roomId: cezarId, deviceId: deviceId, time: time)))]
    }
}
