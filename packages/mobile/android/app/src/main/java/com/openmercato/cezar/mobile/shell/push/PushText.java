package com.openmercato.cezar.mobile.shell.push;

import java.util.Map;

/**
 * What a push says, decided on the phone (switcher spec, "Push"): the relay's payload stays generic,
 * and the computer's name comes from the saved server `s` names. Nothing here leaves the phone.
 */
public final class PushText {
    /** The count in a data-only message; the relay's notification block carries it as notification_count today. */
    public static final String DATA_COUNT = "count";
    private static final int MAX = 99;

    private PushText() {}

    /** The computer's name, or the generic title for a server saved without one. */
    public static String title(String label, String generic) {
        return label == null || label.trim().isEmpty() ? generic : label.trim();
    }

    /** The waiting count a message carried: the data field first, then the notification's; null when neither. */
    public static Integer count(Map<String, String> data, Integer notificationCount) {
        String raw = data == null ? null : data.get(DATA_COUNT);
        if (raw != null && raw.matches("[0-9]{1,9}")) return Integer.parseInt(raw);
        return notificationCount != null && notificationCount >= 0 ? notificationCount : null;
    }

    /**
     * The newest notification's number, so a launcher that sums them shows `total`, the sum of last-known
     * counts. `othersShown` is what the other cezars' notifications already carry. At least 1: it is there.
     */
    public static int number(int total, int othersShown) {
        return Math.min(MAX, Math.max(1, total - Math.max(0, othersShown)));
    }
}
