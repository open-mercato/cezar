import Foundation

/// One grant from `POST /v1/push-grants`, for one server. Opaque: the app never parses `grant`, and never logs it.
struct PushGrant: Equatable {
    let grant: String
    let grantId: String
    /// Unix seconds.
    let expiresAt: Int64
    /// cezar's Ed25519 key the grant names.
    let cezarKey: String
    /// cezar answered the `PUT` with this grant.
    let handedOver: Bool

    /// Java's `handedOver()`: Swift cannot name a method after a stored property.
    func asHandedOver() -> PushGrant {
        PushGrant(grant: grant, grantId: grantId, expiresAt: expiresAt, cezarKey: cezarKey, handedOver: true)
    }
}
