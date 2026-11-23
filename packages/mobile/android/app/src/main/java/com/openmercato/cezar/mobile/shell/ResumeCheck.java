package com.openmercato.cezar.mobile.shell;

/** After a resume, the page that was up must still be: a cockpit can crash while away. Asked once a second. */
public final class ResumeCheck {
    /** Long enough for a relay to reconnect and a page to reload by itself. */
    public static final long WINDOW_MS = 8000;

    public enum Verdict { HEALTHY, WAIT, RESTART }

    private final boolean expectsRoot;
    private long startedAt = -1;

    public ResumeCheck(boolean expectsRoot) {
        this.expectsRoot = expectsRoot;
    }

    public void start(long now) {
        startedAt = now;
    }

    public boolean running() {
        return startedAt >= 0;
    }

    public void stop() {
        startedAt = -1;
    }

    /** {@code state} is the last PageCheck answer, null when none came. */
    public Verdict answer(String state, long now) {
        if (startedAt < 0) return Verdict.HEALTHY;
        if (PageCheck.healthy(state, expectsRoot)) {
            stop();
            return Verdict.HEALTHY;
        }
        if (now - startedAt >= WINDOW_MS) {
            stop();
            return Verdict.RESTART;
        }
        return Verdict.WAIT;
    }
}
