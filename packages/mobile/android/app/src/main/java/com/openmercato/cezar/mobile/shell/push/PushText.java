package com.openmercato.cezar.mobile.shell.push;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * What a push says, decided on the phone (switcher spec, "Push"): the relay's payload stays generic,
 * and the computer's name comes from the saved server `s` names. Nothing here leaves the phone.
 */
public final class PushText {
    /** The count in the relay's data-only message, a decimal string (RELAY_PROTOCOL.md § 7). */
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
     * The cezar ids, a notification's tag, of the relay computers whose waiting count is known to be 0: their
     * notifications go, and the launcher badge with them (spec 2026-11-20-phone-notifications-inbox, B3).
     */
    public static <S> List<String> settled(List<S> servers, Function<S, String> cezarId, Function<S, Integer> waiting) {
        List<String> out = new ArrayList<>();
        for (S server : servers) {
            String id = cezarId.apply(server);
            Integer count = waiting.apply(server);
            if (id != null && !id.isEmpty() && count != null && count == 0) out.add(id);
        }
        return out;
    }

    /**
     * The newest notification's number, so a launcher that sums them shows `total`, the sum of last-known
     * counts. `othersShown` is what the other cezars' notifications already carry. At least 1: it is there.
     */
    public static int number(int total, int othersShown) {
        return Math.min(MAX, Math.max(1, total - Math.max(0, othersShown)));
    }
}
