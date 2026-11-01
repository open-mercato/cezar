package com.openmercato.cezar.mobile.shell.relay;

/** Where a relay connection stands, in the terms of the spec's failure table. */
public final class RelayStatus {
    public enum Kind { IDLE, CONNECTING, READY, RELAY_DOWN, CEZAR_OFFLINE, QUOTA, UPDATE_APP, UPDATE_CEZAR, DEVICE_REMOVED, BROKEN }

    public final Kind kind;
    /** How long until the quota lifts, for {@link Kind#QUOTA}. */
    public final long retryAfterSeconds;

    public RelayStatus(Kind kind, long retryAfterSeconds) {
        this.kind = kind;
        this.retryAfterSeconds = retryAfterSeconds;
    }

    static RelayStatus of(Kind kind) {
        return new RelayStatus(kind, 0);
    }

    /** No retry will change this until the user acts. */
    public boolean terminal() {
        return kind == Kind.UPDATE_APP || kind == Kind.UPDATE_CEZAR || kind == Kind.DEVICE_REMOVED || kind == Kind.BROKEN;
    }
}
