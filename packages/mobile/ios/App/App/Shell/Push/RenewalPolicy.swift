import Foundation

/// What a server open does with this phone's grant, once cezar has said what it holds (spec R5, § 7).
enum RenewalPolicy {
    /// A grant lasts 90 days; the phone renews once under 30 remain.
    static let renewBeforeSeconds: Int64 = 30 * 24 * 60 * 60

    enum Action {
        /// cezar holds this phone's current grant.
        case none
        /// A fresh grant cezar has not had yet, such as one minted on a new token.
        case handOver
        /// A new grant from the relay, then handed over.
        case obtain
    }

    /// `tokenChanged`: APNs gave a new token and no grant for it was got yet, so this one is dead.
    static func decide(_ local: PushGrant?, _ cezar: CezarPush.State, nowSeconds: Int64, tokenChanged: Bool = false) -> Action {
        guard let local, !tokenChanged else { return .obtain }
        if local.cezarKey != cezar.cezarKey { return .obtain }
        if local.expiresAt - nowSeconds < renewBeforeSeconds { return .obtain }
        if local.grantId == cezar.grantId { return .none }
        // cezar dropped a grant it had (a 403 or 410 on send) or holds another: this one is no good.
        return local.handedOver ? .obtain : .handOver
    }
}
