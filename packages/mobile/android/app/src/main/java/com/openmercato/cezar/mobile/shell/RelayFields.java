package com.openmercato.cezar.mobile.shell;

/** What pairing pinned for a relay server. It has no URL and no password (spec "What changes in #1883"). */
public final class RelayFields {
    public final String origin;
    public final String cezarId;
    /** cezar's X25519 key, base64url. */
    public final String cezarKey;
    public final String deviceId;
    /** Saved per server, so its origin keeps storage and HTTP cache across launches. 0 before the first bind. */
    public final int port;

    public RelayFields(String origin, String cezarId, String cezarKey, String deviceId, int port) {
        this.origin = origin;
        this.cezarId = cezarId;
        this.cezarKey = cezarKey;
        this.deviceId = deviceId;
        this.port = port;
    }

    public RelayFields withPort(int value) {
        return new RelayFields(origin, cezarId, cezarKey, deviceId, value);
    }
}
