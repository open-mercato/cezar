package com.openmercato.cezar.mobile.shell.relay;

/** Why the proxy could not deliver a request: the `x-cezar-unreachable` value the cockpit words its banner from (iOS Unreachable). */
public enum Unreachable {
    PEER_OFFLINE("peer-offline"), RELAY_UNREACHABLE("relay-unreachable"), NETWORK_OFFLINE("network-offline"), ACCOUNT_BLOCKED("account-blocked");

    public final String code;

    Unreachable(String code) {
        this.code = code;
    }

    /**
     * The relay's own refusals first, since no network change lifts them; then a phone with no network.
     * A silent handshake is the computer too: a napping Mac can keep its relay socket and answer nothing.
     */
    public static Unreachable of(RelayStatus.Kind kind, boolean networkUp) {
        switch (kind) {
            case EMAIL_UNCONFIRMED:
            case ACCOUNT_REQUIRED:
            case SUSPENDED:
            case TERMS_REQUIRED_DEVICE:
            case DEVICE_REMOVED:
                return ACCOUNT_BLOCKED;
            default:
                break;
        }
        if (!networkUp) return NETWORK_OFFLINE;
        return kind == RelayStatus.Kind.CEZAR_OFFLINE || kind == RelayStatus.Kind.NOT_ANSWERING ? PEER_OFFLINE : RELAY_UNREACHABLE;
    }
}
