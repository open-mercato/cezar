package com.openmercato.cezar.mobile.shell;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Your cezars: what each listed row tells the connect page (spec 2026-11-19-mobile-devices-screen, "Native ↔ page contract"). */
public final class CezarRows {
    public static final int NAME_MAX = 60;

    private CezarRows() {}

    /** One row's status fields. `reason` only for `other`; `need` null when never told. */
    public static final class Row {
        public final ServerRecord server;
        public final String initials;
        public final String color;
        public final String status;
        public final String words;
        public final String reason;
        public final Integer need;

        Row(ServerRecord server, String initials, String color, String status, String words, String reason, Integer need) {
            this.server = server;
            this.initials = initials;
            this.color = color;
            this.status = status;
            this.words = words;
            this.reason = reason;
            this.need = need;
        }
    }

    /** Every saved server in the switcher's order. `current` reads online, as the view on screen is up. */
    public static List<Row> rows(List<ServerRecord> servers, Map<String, DeviceProbes.Reading> readings,
            Map<String, ServerListStore.Seen> seen, String currentId, DeviceSwitch.Clock clock) {
        Map<String, Row> byId = new HashMap<>();
        List<DeviceSwitch.Entry> entries = new ArrayList<>();
        for (ServerRecord server : servers) {
            boolean current = server.id.equals(currentId);
            DeviceProbes.Reading reading = current ? DeviceProbes.Reading.of(HealthAnswer.Kind.CEZAR) : readings.get(server.id);
            if (reading == null) reading = DeviceProbes.Reading.CHECKING;
            ServerListStore.Seen sighting = seen.get(server.id);
            long lastSeen = sighting == null ? 0 : sighting.at;
            Integer need = sighting == null ? null : sighting.need();
            String reason = reason(reading.kind);
            String status = reason != null ? "other" : status(reading.status);
            Row row = new Row(server, Avatar.initials(server.label), hex(Avatar.color(server.label)), status,
                    DeviceSwitch.state(reading, lastSeen, clock).words, reason, need);
            byId.put(server.id, row);
            entries.add(new DeviceSwitch.Entry(server.id, reading.status, need));
        }
        List<Row> out = new ArrayList<>();
        for (String id : DeviceSwitch.order(entries, currentId)) out.add(byId.get(id));
        return out;
    }

    static String status(DeviceSwitch.Status status) {
        switch (status) {
            case CONNECTED:
                return "online";
            case CHECKING:
            case SWITCHING:
                return "checking";
            case OFFLINE:
                return "offline";
            default:
                return "other";
        }
    }

    /** Why a cezar is reachable in no useful way, keyed for the page's one-tap fix; null when it is not. */
    static String reason(String kind) {
        if (kind == null) return null;
        switch (kind) {
            case "BASIC_GATE":
            case "LOGIN_PAGE":
                return "sign-in";
            case "DEVICE_REMOVED":
                return "removed";
            case "EMAIL_UNCONFIRMED":
                return "email";
            case "ACCOUNT_REQUIRED":
                return "account";
            case "TERMS_REQUIRED_DEVICE":
                return "terms";
            case "SUSPENDED":
                return "suspended";
            case "UPDATE_APP":
                return "update-app";
            case "UPDATE_CEZAR":
                return "update-cezar";
            case "QUOTA":
                return "quota";
            case "BROKEN":
            case "TLS_FAILURE":
            case "NOT_CEZAR":
            case "LOCAL_MODE":
                return "broken";
            default:
                return null;
        }
    }

    /** `#rrggbb` from ARGB. */
    static String hex(int argb) {
        return String.format(Locale.ROOT, "#%06x", argb & 0xFFFFFF);
    }

    /** `allowed` | `denied` | `unknown`: unknown while the app may still ask for the permission. */
    public static String notifications(boolean allowed, boolean canAsk) {
        if (allowed) return "allowed";
        return canAsk ? "unknown" : "denied";
    }

    /** A sentence for the user, or null when the name may be saved (trimmed, 1–60 characters). */
    public static String renameError(ServerRecord server, String label) {
        if (server == null) return "This cezar is no longer on this phone.";
        String name = label == null ? "" : label.trim();
        if (name.isEmpty()) return "Enter a name.";
        if (name.codePointCount(0, name.length()) > NAME_MAX) return "Use " + NAME_MAX + " characters or fewer.";
        return null;
    }
}
