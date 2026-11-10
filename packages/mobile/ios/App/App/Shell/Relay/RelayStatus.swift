import Foundation

/// Where a relay connection stands, in the terms of the spec's failure table.
struct RelayStatus: Equatable {
    /// Raw values are the Java names, which `HealthAnswer.fromRelay` reads.
    enum Kind: String {
        case idle = "IDLE", connecting = "CONNECTING", ready = "READY", relayDown = "RELAY_DOWN", cezarOffline = "CEZAR_OFFLINE"
        case notAnswering = "NOT_ANSWERING", quota = "QUOTA", updateApp = "UPDATE_APP", updateCezar = "UPDATE_CEZAR"
        case deviceRemoved = "DEVICE_REMOVED", broken = "BROKEN"
    }

    let kind: Kind
    /// How long until the quota lifts, for `.quota`.
    let retryAfterSeconds: Int64

    init(_ kind: Kind, retryAfterSeconds: Int64 = 0) {
        self.kind = kind
        self.retryAfterSeconds = retryAfterSeconds
    }

    /// No retry will change this until the user acts.
    var terminal: Bool { kind == .updateApp || kind == .updateCezar || kind == .deviceRemoved || kind == .broken }
}
