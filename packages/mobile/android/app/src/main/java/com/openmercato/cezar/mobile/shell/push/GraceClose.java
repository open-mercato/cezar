package com.openmercato.cezar.mobile.shell.push;

/**
 * The relay socket outlives the screen by 30 s, so a signal in that window still shows (spec R5 as
 * built). Only a timer: no service, wake lock or alarm holds it, and a frozen process loses it.
 * Main thread only.
 */
public final class GraceClose {
    public static final long GRACE_MS = 30_000;

    public interface Scheduler {
        void schedule(Runnable task, long delayMs);

        void cancel(Runnable task);
    }

    private final Scheduler scheduler;
    private final Runnable close;
    private final Runnable fire = this::fire;
    private boolean open;
    private boolean pending;

    /** `close` stops the link; it runs at most once per stop. */
    public GraceClose(Scheduler scheduler, Runnable close) {
        this.scheduler = scheduler;
        this.close = close;
    }

    /** The screen started: a pending close is cancelled. True when the socket had closed, or never opened. */
    public boolean started() {
        if (pending) {
            pending = false;
            scheduler.cancel(fire);
        }
        boolean wasOpen = open;
        open = true;
        return !wasOpen;
    }

    /** The screen stopped: the close is due in {@link #GRACE_MS}. */
    public void stopped() {
        if (!open || pending) return;
        pending = true;
        scheduler.schedule(fire, GRACE_MS);
    }

    /** The screen is gone, and its link with it. */
    public void cancel() {
        if (pending) scheduler.cancel(fire);
        pending = false;
        open = false;
    }

    public boolean pending() {
        return pending;
    }

    private void fire() {
        if (!pending) return;
        pending = false;
        open = false;
        close.run();
    }
}
