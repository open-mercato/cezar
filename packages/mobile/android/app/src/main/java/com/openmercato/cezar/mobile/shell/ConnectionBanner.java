package com.openmercato.cezar.mobile.shell;

import com.openmercato.cezar.mobile.shell.relay.RelayStatus;

/** The native banner over a relay page: the spec's "How a failure appears in the app" table, and nothing else. */
public final class ConnectionBanner {
    /** Under this, a reconnect shows nothing. */
    public static final long GRACE_MS = 5000;

    public final String text;
    public final boolean retry;

    private ConnectionBanner(String text, boolean retry) {
        this.text = text;
        this.retry = retry;
    }

    /** Null means no banner. A device removal is a full screen, not a banner. */
    public static ConnectionBanner of(RelayStatus status, long notReadyForMs) {
        switch (status.kind) {
            case UPDATE_APP:
                return new ConnectionBanner("Update the app.", false);
            case UPDATE_CEZAR:
                return new ConnectionBanner("Update cezar on your computer.", false);
            case BROKEN:
                return new ConnectionBanner("Something is wrong with this connection. Updating the app or cezar may help.", true);
            default:
                break;
        }
        if (notReadyForMs < GRACE_MS) return null;
        switch (status.kind) {
            case RELAY_DOWN:
                return new ConnectionBanner("Can't reach the Cezar relay. Your computer is fine. Retrying…", true);
            case CEZAR_OFFLINE:
                return new ConnectionBanner("Your computer is asleep or cezar isn't running.", true);
            case QUOTA:
                return new ConnectionBanner("Too much traffic today. Back in " + Math.max(1, (status.retryAfterSeconds + 59) / 60) + " minutes.", false);
            default:
                return null;
        }
    }
}
