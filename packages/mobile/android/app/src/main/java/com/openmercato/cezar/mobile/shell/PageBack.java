package com.openmercato.cezar.mobile.shell;

/** Back on the connect page: the page decides first, through `window.cezarBack` (connect.js). */
public final class PageBack {
    /** Asked with evaluateJavascript, which answers with the JSON of the value. */
    public static final String SCRIPT = "typeof window.cezarBack === 'function' && window.cezarBack() === true";

    private PageBack() {}

    /** Anything but a plain `true` (no page yet, a script error, `null`) leaves Back to native. */
    public static boolean handled(String answer) {
        return "true".equals(answer);
    }
}
