package com.openmercato.cezar.mobile.shell;

import com.openmercato.cezar.mobile.shell.relay.AccountClient;

/** The gentle banner while the computer's relay email waits for confirmation (RELAY_PROTOCOL.md § 18). */
public final class AccountReminder {
    private AccountReminder() {}

    /** Null unless pending: a confirmed account needs nothing, a blocked one never reaches a page. */
    public static String text(AccountClient.Status status) {
        if (status == null || !"pending".equals(status.state)) return null;
        String left = status.secondsLeft >= 0 ? " within " + timeLeft(status.secondsLeft) : "";
        return "Confirm your computer's email" + left + " to keep this phone connected.";
    }

    /** "47 h", "3 h 20 min", "12 min". */
    public static String timeLeft(long seconds) {
        if (seconds < 60) return "a minute";
        long hours = seconds / 3600;
        long minutes = (seconds % 3600) / 60;
        if (hours >= 10) return hours + " h";
        if (hours > 0) return minutes > 0 ? hours + " h " + minutes + " min" : hours + " h";
        return minutes + " min";
    }
}
