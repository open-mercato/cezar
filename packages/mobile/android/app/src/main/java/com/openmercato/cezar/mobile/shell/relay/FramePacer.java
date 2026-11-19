package com.openmercato.cezar.mobile.shell.relay;

import java.util.function.LongSupplier;

/**
 * The relay counts frames per room, both directions, and closes the sender with 4429 past
 * `framesPerSecond` (RELAY_PROTOCOL.md § 12.2). cezar paces itself to 40%; the phone takes the same share.
 */
final class FramePacer {
    interface Sleeper {
        void sleep(long ms) throws InterruptedException;
    }

    private static final double SHARE_OF_FRAMES = 0.4;

    private final double spacingMs;
    private final LongSupplier clock;
    private final Sleeper sleeper;
    private double nextAt;

    FramePacer(int framesPerSecond, LongSupplier clock, Sleeper sleeper) {
        this.spacingMs = 1000.0 / Math.max(1.0, framesPerSecond * SHARE_OF_FRAMES);
        this.clock = clock;
        this.sleeper = sleeper;
    }

    /** Takes the next slot under the lock and waits outside it, so streams do not queue on each other. */
    void await() throws InterruptedException {
        long waitMs;
        synchronized (this) {
            long now = clock.getAsLong();
            double at = Math.max(now, nextAt);
            nextAt = at + spacingMs;
            waitMs = (long) Math.ceil(at - now);
        }
        if (waitMs > 0) sleeper.sleep(waitMs);
    }
}
