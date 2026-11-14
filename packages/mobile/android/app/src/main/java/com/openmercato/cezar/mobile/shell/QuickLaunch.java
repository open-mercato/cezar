package com.openmercato.cezar.mobile.shell;

/**
 * A plain cold start of the last relay server, its bundle on the phone: the server view opens from
 * the launcher itself, not after the connect page has booted and asked. Anything else, the lock first
 * of all, goes the usual way through the connect page.
 */
public final class QuickLaunch {
    private static boolean launching;

    private QuickLaunch() {}

    public static boolean applies(boolean fresh, boolean mainAction, boolean lockEnabled, boolean routePending, boolean tapPending, boolean serverOpen, String cachedPath) {
        return fresh && mainAction && !lockEnabled && !routePending && !tapPending && !serverOpen && cachedPath != null;
    }

    /** Until the server view counts itself open, the connect page's launch must not open a second one. */
    static synchronized void started() {
        launching = true;
    }

    static synchronized void arrived() {
        launching = false;
    }

    static synchronized boolean launching() {
        return launching;
    }
}
