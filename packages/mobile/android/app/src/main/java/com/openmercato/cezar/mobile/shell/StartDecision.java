package com.openmercato.cezar.mobile.shell;

/** Where a cold launch goes: the "In the shell" table of the spec, and nothing else. */
public final class StartDecision {
    public enum Route {
        MANAGER, ROOT_MANAGERS_OFF, ROOT_OLD_SERVER, ROOT_LOGIN,
        ASK_CREDENTIALS, PASSWORD_REJECTED, LOCAL_MODE, CONNECTION_ERROR,
        CEZAR_OFFLINE, RELAY_DOWN, DEVICE_REMOVED, PROTOCOL_MISMATCH
    }

    private StartDecision() {}

    public static Route decide(HealthAnswer health, boolean passwordSaved) {
        switch (health.kind) {
            case CEZAR:
                if (health.managers == null) return Route.ROOT_OLD_SERVER;
                return health.managers ? Route.MANAGER : Route.ROOT_MANAGERS_OFF;
            case BASIC_GATE:
                return passwordSaved ? Route.PASSWORD_REJECTED : Route.ASK_CREDENTIALS;
            case LOCAL_MODE:
                return Route.LOCAL_MODE;
            case LOGIN_PAGE:
                return Route.ROOT_LOGIN;
            case CEZAR_OFFLINE:
                return Route.CEZAR_OFFLINE;
            case RELAY_DOWN:
            case QUOTA:
                return Route.RELAY_DOWN;
            case DEVICE_REMOVED:
                return Route.DEVICE_REMOVED;
            case UPDATE_APP:
            case UPDATE_CEZAR:
                return Route.PROTOCOL_MISMATCH;
            default:
                return Route.CONNECTION_ERROR;
        }
    }

    public static String path(Route route) {
        return route == Route.MANAGER ? "/manager" : "/";
    }
}
