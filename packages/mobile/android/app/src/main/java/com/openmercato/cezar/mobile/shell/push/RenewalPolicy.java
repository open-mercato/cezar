package com.openmercato.cezar.mobile.shell.push;

/** What a server open does with this phone's grant, once cezar has said what it holds (spec R5, § 7). */
public final class RenewalPolicy {
    /** A grant lasts 90 days; the phone renews once under 30 remain. */
    public static final long RENEW_BEFORE_SECONDS = 30L * 24 * 60 * 60;

    public enum Action {
        /** cezar holds this phone's current grant. */
        NONE,
        /** A fresh grant cezar has not had yet, such as one minted on a new token. */
        HAND_OVER,
        /** A new grant from the relay, then handed over. */
        OBTAIN
    }

    private RenewalPolicy() {}

    public static Action decide(PushGrant local, CezarPush.State cezar, long nowSeconds) {
        return decide(local, cezar, nowSeconds, false);
    }

    /** `tokenChanged`: FCM rotated the token and no grant for the new one was got yet, so this one is dead. */
    public static Action decide(PushGrant local, CezarPush.State cezar, long nowSeconds, boolean tokenChanged) {
        if (local == null || tokenChanged) return Action.OBTAIN;
        if (!local.cezarKey.equals(cezar.cezarKey)) return Action.OBTAIN;
        if (local.expiresAt - nowSeconds < RENEW_BEFORE_SECONDS) return Action.OBTAIN;
        if (local.grantId.equals(cezar.grantId)) return Action.NONE;
        // cezar dropped a grant it had (a 403 or 410 on send) or holds another: this one is no good.
        return local.handedOver ? Action.OBTAIN : Action.HAND_OVER;
    }
}
