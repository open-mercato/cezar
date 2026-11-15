package com.openmercato.cezar.mobile.shell;

import com.openmercato.cezar.mobile.shell.relay.RelayStatus;

/** The device switcher's decisions: a row's status, its spoken text, and where a switch lands. */
public final class DeviceSwitch {
    public enum Status {
        CONNECTED("connected"), OFFLINE("offline"), CHECKING("checking"), ATTENTION("needs attention"), BLOCKED("blocked"), SWITCHING("switching");

        public final String spoken;

        Status(String spoken) {
            this.spoken = spoken;
        }
    }

    /** How long a probe may take before its row reads offline. */
    public static final long PROBE_MS = 6000;
    public static final String MANAGER = "/manager";
    /** The global Tasks page: project ids differ across computers. */
    public static final String TASKS = "/tasks";

    private DeviceSwitch() {}

    public static Status of(RelayStatus.Kind kind) {
        switch (kind) {
            case READY:
                return Status.CONNECTED;
            case EMAIL_UNCONFIRMED:
            case ACCOUNT_REQUIRED:
            case UPDATE_APP:
            case UPDATE_CEZAR:
                return Status.ATTENTION;
            case SUSPENDED:
            case TERMS_REQUIRED_DEVICE:
            case DEVICE_REMOVED:
                return Status.BLOCKED;
            default:
                return Status.OFFLINE;
        }
    }

    /** Connecting, or not started: a relay link that has not answered yet. */
    public static boolean answered(RelayStatus.Kind kind) {
        return kind != RelayStatus.Kind.CONNECTING && kind != RelayStatus.Kind.IDLE;
    }

    /** A direct server's health probe. */
    public static Status of(HealthAnswer.Kind kind) {
        switch (kind) {
            case CEZAR:
                return Status.CONNECTED;
            case BASIC_GATE:
            case LOGIN_PAGE:
            case LOCAL_MODE:
            case EMAIL_UNCONFIRMED:
            case ACCOUNT_REQUIRED:
            case UPDATE_APP:
            case UPDATE_CEZAR:
                return Status.ATTENTION;
            case SUSPENDED:
            case TERMS_REQUIRED_DEVICE:
            case DEVICE_REMOVED:
                return Status.BLOCKED;
            default:
                return Status.OFFLINE;
        }
    }

    /** The muted second line. */
    public static String detail(ServerRecord server) {
        if (server.relay != null) return "Through the relay";
        try {
            return ServerOrigin.parse(server.url).host;
        } catch (ServerOrigin.InvalidUrl e) {
            return server.url;
        }
    }

    public static String spoken(String label, Status status, boolean current) {
        return label + ", " + status.spoken + (current ? ", current" : "");
    }

    /** The same kind of page on the other computer: Manager stays Manager, anything else is Tasks. */
    public static String landingPath(String currentUrl) {
        String path = pathOf(currentUrl);
        return path.equals(MANAGER) || path.startsWith(MANAGER + "/") ? MANAGER : TASKS;
    }

    /** The path of an absolute URL, without query or fragment; "" when there is none. */
    static String pathOf(String url) {
        if (url == null) return "";
        int scheme = url.indexOf("://");
        int start = scheme < 0 ? 0 : url.indexOf('/', scheme + 3);
        if (start < 0) return "";
        int end = url.length();
        for (char stop : new char[] {'?', '#'}) {
            int at = url.indexOf(stop, start);
            if (at >= 0 && at < end) end = at;
        }
        return url.substring(start, end);
    }
}
