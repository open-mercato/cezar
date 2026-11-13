import Foundation

/// Where a relay connection stands, in the terms of the spec's failure table.
struct RelayStatus: Equatable {
    /// Raw values are the Java names, which `HealthAnswer.fromRelay` reads.
    enum Kind: String {
        case idle = "IDLE", connecting = "CONNECTING", ready = "READY", relayDown = "RELAY_DOWN", cezarOffline = "CEZAR_OFFLINE"
        case notAnswering = "NOT_ANSWERING", quota = "QUOTA", updateApp = "UPDATE_APP", updateCezar = "UPDATE_CEZAR"
        case deviceRemoved = "DEVICE_REMOVED", broken = "BROKEN"
        /// The relay refused with 4451 (RELAY_PROTOCOL.md § 18).
        case emailUnconfirmed = "EMAIL_UNCONFIRMED", accountRequired = "ACCOUNT_REQUIRED"
        /// 4451 `suspended` (the operator's) and `terms-required-device` (this phone's terms): no auto retry.
        case suspended = "SUSPENDED", termsRequiredDevice = "TERMS_REQUIRED_DEVICE"
    }

    let kind: Kind
    /// How long until the quota lifts, for `.quota`.
    let retryAfterSeconds: Int64

    init(_ kind: Kind, retryAfterSeconds: Int64 = 0) {
        self.kind = kind
        self.retryAfterSeconds = retryAfterSeconds
    }

    /// No retry will change this until the user acts.
    var terminal: Bool {
        kind == .updateApp || kind == .updateCezar || kind == .deviceRemoved || kind == .broken || kind == .emailUnconfirmed || kind == .accountRequired
            || kind == .suspended || kind == .termsRequiredDevice
    }
}
