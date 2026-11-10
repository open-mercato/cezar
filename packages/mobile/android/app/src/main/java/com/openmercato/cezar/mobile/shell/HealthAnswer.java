package com.openmercato.cezar.mobile.shell;

/** What `GET /api/v1/health` said, in the terms of the add-server table (spec Decision 2). */
public final class HealthAnswer {
    public enum Kind {
        CEZAR, BASIC_GATE, LOCAL_MODE, LOGIN_PAGE, TLS_FAILURE, UNREACHABLE, NOT_CEZAR,
        /** Relay servers only: why the tunnel gave no answer. */
        CEZAR_OFFLINE, NOT_ANSWERING, RELAY_DOWN, QUOTA, DEVICE_REMOVED, UPDATE_APP, UPDATE_CEZAR
    }

    public final Kind kind;
    public final int status;
    /** The Basic realm, when {@link Kind#BASIC_GATE}. */
    public final String realm;
    public final String version;
    /** `capabilities.managers`; null when the server does not send it. */
    public final Boolean managers;

    HealthAnswer(Kind kind, int status, String realm, String version, Boolean managers) {
        this.kind = kind;
        this.status = status;
        this.realm = realm;
        this.version = version;
        this.managers = managers;
    }

    public static HealthAnswer of(Kind kind, int status) {
        return new HealthAnswer(kind, status, null, null, null);
    }

    /** A relay status that is not READY. `CONNECTING` past the wait reads as a relay outage, never as the computer. */
    public static HealthAnswer fromRelay(String relayKind, int minutes) {
        switch (relayKind) {
            case "CEZAR_OFFLINE":
                return of(Kind.CEZAR_OFFLINE, 0);
            case "NOT_ANSWERING":
                return of(Kind.NOT_ANSWERING, 0);
            case "QUOTA":
                return of(Kind.QUOTA, minutes);
            case "DEVICE_REMOVED":
                return of(Kind.DEVICE_REMOVED, 0);
            case "UPDATE_APP":
                return of(Kind.UPDATE_APP, 0);
            case "UPDATE_CEZAR":
                return of(Kind.UPDATE_CEZAR, 0);
            case "BROKEN":
                return of(Kind.NOT_CEZAR, 0);
            default:
                return of(Kind.RELAY_DOWN, 0);
        }
    }
}
