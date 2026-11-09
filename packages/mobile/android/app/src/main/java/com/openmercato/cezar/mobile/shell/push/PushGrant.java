package com.openmercato.cezar.mobile.shell.push;

/** One grant from `POST /v1/push-grants`, for one server. Opaque: the app never parses `grant`, and never logs it. */
public final class PushGrant {
    public final String grant;
    public final String grantId;
    /** Unix seconds. */
    public final long expiresAt;
    /** cezar's Ed25519 key the grant names. */
    public final String cezarKey;
    /** cezar answered the `PUT` with this grant. */
    public final boolean handedOver;

    public PushGrant(String grant, String grantId, long expiresAt, String cezarKey, boolean handedOver) {
        this.grant = grant;
        this.grantId = grantId;
        this.expiresAt = expiresAt;
        this.cezarKey = cezarKey;
        this.handedOver = handedOver;
    }

    public PushGrant handedOver() {
        return new PushGrant(grant, grantId, expiresAt, cezarKey, true);
    }
}
