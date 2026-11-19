package com.openmercato.cezar.mobile.shell;

import com.openmercato.cezar.mobile.shell.relay.RelayStatus;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.TimeZone;

/** The device switcher's decisions: a row's status and words, the order, and where a switch lands (switcher spec). */
public final class DeviceSwitch {
    public enum Status { CONNECTED, OFFLINE, CHECKING, ATTENTION, BLOCKED, SWITCHING }

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

    /** A row's state: the coarse status that orders and colours it, and the plain words under its name. */
    public static final class State {
        public final Status status;
        public final String words;

        public State(Status status, String words) {
            this.status = status;
            this.words = words;
        }

        public static final State CHECKING = new State(Status.CHECKING, "Checking…");
        public static final State SWITCHING = new State(Status.SWITCHING, "Opening…");
    }

    /** Clock and formats for "Offline since …": the sheet passes the phone's, tests pin their own. */
    public static final class Clock {
        final long now;
        final TimeZone zone;
        final DateFormat time;
        final DateFormat day;

        public Clock(long now, TimeZone zone, DateFormat time, DateFormat day) {
            this.now = now;
            this.zone = zone;
            this.time = time;
            this.day = day;
            time.setTimeZone(zone);
            day.setTimeZone(zone);
        }
    }

    public static State state(RelayStatus.Kind kind, long lastSeen, Clock clock) {
        return state(of(kind), kind.name(), lastSeen, clock);
    }

    public static State state(HealthAnswer.Kind kind, long lastSeen, Clock clock) {
        return state(of(kind), kind.name(), lastSeen, clock);
    }

    /** A probe's reading: checking, offline at the bound, or its kind's words. */
    public static State state(DeviceProbes.Reading reading, long lastSeen, Clock clock) {
        if (reading.kind == null) return reading.status == Status.CHECKING ? State.CHECKING : offline(lastSeen, clock);
        return state(reading.status, reading.kind, lastSeen, clock);
    }

    public static State offline(long lastSeen, Clock clock) {
        return new State(Status.OFFLINE, offlineWords(lastSeen, clock));
    }

    private static State state(Status status, String kind, long lastSeen, Clock clock) {
        String words = plain(kind);
        return new State(status, words != null ? words : offlineWords(lastSeen, clock));
    }

    /** Short words per kind; null for the ones that read as offline. */
    static String plain(String kind) {
        switch (kind) {
            case "READY":
            case "CEZAR":
                return "Online";
            case "EMAIL_UNCONFIRMED":
                return "Email not confirmed";
            case "ACCOUNT_REQUIRED":
            case "BASIC_GATE":
            case "LOGIN_PAGE":
                return "Sign in needed";
            case "SUSPENDED":
                return "Suspended";
            case "TERMS_REQUIRED_DEVICE":
                return "Terms not accepted";
            case "DEVICE_REMOVED":
                return "This phone was removed";
            case "UPDATE_APP":
                return "Update the app";
            case "UPDATE_CEZAR":
                return "Update cezar";
            case "QUOTA":
                return "Over the limit";
            case "LOCAL_MODE":
                return "Local only";
            case "RELAY_DOWN":
            case "BROKEN":
            case "TLS_FAILURE":
            case "NOT_CEZAR":
                return "Can't connect";
            default:
                return null;
        }
    }

    /** "Offline since 14:02" today, "Offline since 12 Nov" before, plain "Offline" if never seen. */
    static String offlineWords(long lastSeen, Clock clock) {
        if (lastSeen <= 0 || clock == null) return "Offline";
        Date seen = new Date(lastSeen);
        return "Offline since " + (sameDay(lastSeen, clock.now, clock.zone) ? clock.time.format(seen) : clock.day.format(seen));
    }

    private static boolean sameDay(long a, long b, TimeZone zone) {
        Calendar one = Calendar.getInstance(zone);
        one.setTimeInMillis(a);
        Calendar two = Calendar.getInstance(zone);
        two.setTimeInMillis(b);
        return one.get(Calendar.YEAR) == two.get(Calendar.YEAR) && one.get(Calendar.DAY_OF_YEAR) == two.get(Calendar.DAY_OF_YEAR);
    }

    /** "1 needs you", "3 need you"; null for none or unknown. */
    public static String needText(Integer need) {
        if (need == null || need <= 0) return null;
        return need + (need == 1 ? " needs you" : " need you");
    }

    /** One row as the sort sees it. */
    public static final class Entry {
        final String id;
        final Status status;
        final Integer need;

        public Entry(String id, Status status, Integer need) {
            this.id = id;
            this.status = status;
            this.need = need;
        }
    }

    /** Current first, then online, then offline (and still checking), then the rest; by need within a group. Stable. */
    public static List<String> order(List<Entry> entries, String currentId) {
        List<Entry> rest = new ArrayList<>();
        List<String> out = new ArrayList<>();
        for (Entry entry : entries) {
            if (entry.id.equals(currentId)) out.add(entry.id);
            else rest.add(entry);
        }
        Collections.sort(rest, (a, b) -> {
            int group = Integer.compare(group(a.status), group(b.status));
            return group != 0 ? group : Integer.compare(need(b), need(a));
        });
        for (Entry entry : rest) out.add(entry.id);
        return out;
    }

    private static int group(Status status) {
        switch (status) {
            case CONNECTED:
                return 0;
            case OFFLINE:
            case CHECKING:
                return 1;
            default:
                return 2;
        }
    }

    private static int need(Entry entry) {
        return entry.need == null ? 0 : entry.need;
    }

    public static String spoken(String label, String words, Integer need, boolean current) {
        String needs = current ? null : needText(need);
        return label + ", " + words + (needs != null ? ", " + needs : "") + (current ? ", current" : "");
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
