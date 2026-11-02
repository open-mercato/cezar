package com.openmercato.cezar.mobile.shell;

/**
 * Decides whether the app must ask for the phone's credential now (spec QR3). Pure: the caller
 * passes SystemClock.elapsedRealtime, which a changed clock cannot move.
 */
public final class LockPolicy {
    /** How long the app may stay in the background without a new prompt (spec QR3). */
    public static final long TIMEOUT_MS = 60_000;
    private static final long NOT_AWAY = -1;

    private boolean passed;
    private long leftAt = NOT_AWAY;
    private boolean prompting;
    private boolean offered;

    public boolean promptNeeded(boolean enabled) {
        return enabled && !passed;
    }

    /** At most one automatic prompt per return: a cancel falls back to the Unlock button, not a loop. */
    public boolean autoPrompt(boolean enabled) {
        return promptNeeded(enabled) && !prompting && !offered;
    }

    /** Recorded during a prompt too: pressing Home on a toggle's prompt must still start the timeout. */
    public void left(long now, boolean changingConfigurations) {
        if (changingConfigurations) return;
        if (leftAt == NOT_AWAY) leftAt = now;
        if (!prompting) offered = false;
    }

    public void returned(long now) {
        if (leftAt == NOT_AWAY) return;
        long away = now - leftAt;
        leftAt = NOT_AWAY;
        if (away < 0 || away >= TIMEOUT_MS) passed = false;
    }

    public void promptStarted() {
        prompting = true;
        offered = true;
    }

    public void promptEnded() {
        prompting = false;
    }

    public void passed() {
        passed = true;
        leftAt = NOT_AWAY;
        offered = false;
    }
}
