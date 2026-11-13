package com.openmercato.cezar.mobile.shell;

import com.openmercato.cezar.mobile.shell.relay.RelayStatus;

/**
 * Decides when the launch view over a server page goes, and how. Every step has a deadline that a
 * timer checks, so a lost paint answer, a hung tunnel or a silent cezar end in the page or in the
 * Connection problem panel, never in a logo that stays.
 */
public final class StartupWatchdog {
    /** Relay connect and KK handshake, with nothing on screen yet. */
    public static final long CONNECT_MS = 10000;
    /** From the session (or the start, with a cached shell) to the page's first byte. */
    public static final long FIRST_BYTE_MS = 10000;
    /** From the first byte to the page's load event. */
    public static final long LOAD_MS = 15000;
    /** The paint signal is optional: past this after the load event, the page shows anyway. */
    public static final long PAINT_GRACE_MS = 2000;
    /** Nothing at all may take longer. */
    public static final long MAX_MS = 30000;

    public enum Kind { WAIT, REVEAL, PROBLEM }

    public static final class Decision {
        public final Kind kind;
        /** WAIT: the launch view's status line. PROBLEM: the reason. */
        public final String text;

        private Decision(Kind kind, String text) {
            this.kind = kind;
            this.text = text;
        }

        @Override
        public String toString() {
            return kind + (text == null ? "" : ": " + text);
        }
    }

    private final String serverLabel;
    private final boolean relay;
    private long startedAt = -1;
    private long readyAt = -1;
    private long firstByteAt = -1;
    private long loadedAt = -1;
    private boolean painted;
    private String error;
    private RelayStatus.Kind status = RelayStatus.Kind.IDLE;
    private Decision settled;

    /** `relay`: false for a Manual server, which has no relay steps to wait for. */
    public StartupWatchdog(String serverLabel, boolean relay) {
        this.serverLabel = serverLabel == null || serverLabel.isEmpty() ? "your computer" : serverLabel;
        this.relay = relay;
    }

    public void start(long now) {
        startedAt = now;
        readyAt = relay ? -1 : now;
        firstByteAt = loadedAt = -1;
        painted = false;
        error = null;
        settled = null;
    }

    public boolean started() {
        return startedAt >= 0;
    }

    public void relayStatus(RelayStatus.Kind kind, long now) {
        status = kind;
        if (kind == RelayStatus.Kind.READY && readyAt < 0) readyAt = now;
    }

    /** The page committed: its first byte arrived, from the tunnel or from the phone's cache. */
    public void firstByte(long now) {
        if (firstByteAt < 0) firstByteAt = now;
    }

    public void loaded(long now) {
        firstByte(now);
        if (loadedAt < 0) loadedAt = now;
    }

    public void painted() {
        painted = true;
    }

    /** The main frame failed to load. */
    public void failed(String reason) {
        if (error == null) error = reason;
    }

    /** Once REVEAL or PROBLEM, it stays so until the next start. */
    public Decision decide(long now) {
        if (settled != null) return settled;
        Decision next = evaluate(now);
        if (next.kind != Kind.WAIT) settled = next;
        return next;
    }

    private Decision evaluate(long now) {
        if (startedAt < 0) return new Decision(Kind.WAIT, connecting());
        // A proxy's 503 page is "painted" too: the failure wins.
        if (error != null) return new Decision(Kind.PROBLEM, error);
        if (painted) return new Decision(Kind.REVEAL, null);
        long elapsed = now - startedAt;
        String terminal = terminalReason(status);
        // A page from the phone's cache can stand without a session; the banner then says why.
        if (terminal != null && firstByteAt < 0) return new Decision(Kind.PROBLEM, terminal);
        if (loadedAt >= 0) {
            return now - loadedAt >= PAINT_GRACE_MS ? new Decision(Kind.REVEAL, null) : new Decision(Kind.WAIT, LOADING);
        }
        if (firstByteAt >= 0) {
            if (now - firstByteAt >= LOAD_MS || elapsed >= MAX_MS) return new Decision(Kind.PROBLEM, "The cockpit started loading but did not finish.");
            return new Decision(Kind.WAIT, LOADING);
        }
        if (readyAt < 0) {
            if (elapsed >= CONNECT_MS) return new Decision(Kind.PROBLEM, connectReason(status));
            return new Decision(Kind.WAIT, connecting());
        }
        if (now - readyAt >= FIRST_BYTE_MS || elapsed >= MAX_MS) return new Decision(Kind.PROBLEM, "Connected, but cezar did not send the cockpit.");
        return new Decision(Kind.WAIT, LOADING);
    }

    public static final String LOADING = "Loading cockpit…";

    private String connecting() {
        return "Connecting to " + serverLabel + "…";
    }

    private static String terminalReason(RelayStatus.Kind kind) {
        switch (kind) {
            case UPDATE_APP:
                return "Update the app: this cezar needs a newer one.";
            case UPDATE_CEZAR:
                return "Update cezar on your computer: this app needs a newer one.";
            case BROKEN:
                return "Something is wrong with this connection. Updating the app or cezar may help.";
            case DEVICE_REMOVED:
                return "This phone was removed on the computer. Pair it again.";
            default:
                return null;
        }
    }

    private static String connectReason(RelayStatus.Kind kind) {
        switch (kind) {
            case RELAY_DOWN:
                return "Can't reach the Cezar relay.";
            case CEZAR_OFFLINE:
                return "Your computer is asleep or cezar isn't running.";
            case NOT_ANSWERING:
                return "cezar is not answering the secure handshake.";
            case QUOTA:
                return "The relay is over today's traffic limit.";
            default:
                return "The relay connection timed out.";
        }
    }
}
