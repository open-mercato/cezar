package com.openmercato.cezar.mobile.shell;

import java.util.Locale;
import java.util.regex.Pattern;

/** A computer's automatic identity: colour and initials from its name, byte-identical to the web and iOS (switcher spec). */
public final class Avatar {
    private static final int[] PALETTE = {0xFF7C6CF0, 0xFFE0912A, 0xFF2FB862, 0xFF2A9FD8, 0xFFE05A73, 0xFF22B3A0};
    private static final Pattern SPACE = Pattern.compile("\\s+", Pattern.UNICODE_CHARACTER_CLASS);
    private static final Pattern EDGES = Pattern.compile("^\\s+|\\s+$", Pattern.UNICODE_CHARACTER_CLASS);

    private Avatar() {}

    /** ARGB. The hash runs over UTF-16 code units, as JS charCodeAt does. */
    public static int color(String name) {
        long h = 0;
        for (char c : trim(name).toCharArray()) h = (h * 31 + c) & 0xffffffffL;
        return PALETTE[(int) (h % PALETTE.length)];
    }

    /** Up to two letters or digits, uppercased; "" means the generic laptop glyph. */
    public static String initials(String name) {
        StringBuilder out = new StringBuilder();
        int taken = 0;
        for (String word : SPACE.split(trim(name))) {
            if (word.isEmpty() || taken == 2) continue;
            int first = word.codePointAt(0);
            if (!letterOrDigit(first)) continue;
            out.appendCodePoint(first);
            taken++;
        }
        return out.toString().toUpperCase(Locale.ROOT);
    }

    /** \p{L} or \p{N}. */
    private static boolean letterOrDigit(int codePoint) {
        switch (Character.getType(codePoint)) {
            case Character.UPPERCASE_LETTER:
            case Character.LOWERCASE_LETTER:
            case Character.TITLECASE_LETTER:
            case Character.MODIFIER_LETTER:
            case Character.OTHER_LETTER:
            case Character.DECIMAL_DIGIT_NUMBER:
            case Character.LETTER_NUMBER:
            case Character.OTHER_NUMBER:
                return true;
            default:
                return false;
        }
    }

    private static String trim(String name) {
        return name == null ? "" : EDGES.matcher(name).replaceAll("");
    }
}
