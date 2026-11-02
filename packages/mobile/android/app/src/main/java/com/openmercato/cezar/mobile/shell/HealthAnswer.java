package com.openmercato.cezar.mobile.shell;

/** What `GET /api/v1/health` said, in the terms of the add-server table (spec Decision 2). */
public final class HealthAnswer {
    public enum Kind { CEZAR, BASIC_GATE, LOCAL_MODE, LOGIN_PAGE, TLS_FAILURE, UNREACHABLE, NOT_CEZAR }

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

    static HealthAnswer of(Kind kind, int status) {
        return new HealthAnswer(kind, status, null, null, null);
    }
}
