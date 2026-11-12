package com.openmercato.cezar.mobile.shell;

import java.util.function.LongSupplier;

/**
 * Keeps the system splash up through a cold start that will open a server, so the connect page
 * never flashes between the splash and the server view's own cover. Bounded, whatever happens.
 */
public final class LaunchHold {
    public static final long MAX_MS = 4000;
    public static final LaunchHold SHARED = new LaunchHold(System::currentTimeMillis);

    private final LongSupplier clock;
    private long until;

    LaunchHold(LongSupplier clock) {
        this.clock = clock;
    }

    public synchronized void start() {
        until = clock.getAsLong() + MAX_MS;
    }

    /** The page has something else to show, or the server view is up. */
    public synchronized void release() {
        until = 0;
    }

    public synchronized boolean holding() {
        return until != 0 && clock.getAsLong() < until;
    }
}
