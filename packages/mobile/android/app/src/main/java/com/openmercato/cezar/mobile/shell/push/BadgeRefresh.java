package com.openmercato.cezar.mobile.shell.push;

import java.util.ArrayList;
import java.util.List;
import java.util.function.LongSupplier;

/**
 * Keeps the launcher badge true outside Your cezars (spec 2026-11-20-phone-notifications-inbox, B1): one probe round
 * over every saved cezar as the app comes to the front, and one a minute while a cezar's page is on screen. Each round
 * ends in `apply`, which clears what reached 0. iOS has the same.
 */
public final class BadgeRefresh {
    public static final long PAGE_EVERY_MS = 60_000;
    /** Coming back within this reuses the last round: a pulled-down shade is not a new visit. */
    public static final long MIN_GAP_MS = 10_000;

    /** One probe round over every saved cezar; `done` runs once, on any thread. */
    public interface Round {
        void run(Runnable done);
    }

    public interface Scheduler {
        void after(long ms, Runnable work);
    }

    private final Round round;
    private final Scheduler schedule;
    private final LongSupplier clock;
    private final Runnable apply;
    private final List<String> pages = new ArrayList<>();
    private boolean running;
    private Long lastAt;
    private int generation;
    private int holds;

    public BadgeRefresh(Round round, Scheduler schedule, LongSupplier clock, Runnable apply) {
        this.round = round;
        this.schedule = schedule;
        this.clock = clock;
        this.apply = apply;
    }

    /** The app came to the front. */
    public void resumed() {
        refresh(false);
    }

    /** A cezar's page is on screen: read now, then every minute until the last page leaves. */
    public void pageStarted(String serverId) {
        if (serverId == null) return;
        int ticking;
        boolean first;
        synchronized (this) {
            pages.add(serverId);
            first = pages.size() == 1;
            if (first) generation++;
            ticking = generation;
        }
        if (first) tick(ticking);
        refresh(false);
    }

    public synchronized void pageStopped(String serverId) {
        if (serverId == null) return;
        pages.remove(serverId);
        if (pages.isEmpty()) generation++;
    }

    /** The device sheet probes and warms its own links: no round may let them go under it. */
    public synchronized void hold(boolean on) {
        holds = Math.max(0, holds + (on ? 1 : -1));
    }

    /** The device sheet is open: a round that ends now leaves the warm links to it. */
    public synchronized boolean held() {
        return holds > 0;
    }

    private void tick(int ticking) {
        schedule.after(PAGE_EVERY_MS, () -> {
            synchronized (this) {
                if (ticking != generation) return;
            }
            refresh(true);
            tick(ticking);
        });
    }

    private void refresh(boolean force) {
        long now = clock.getAsLong();
        synchronized (this) {
            if (running || holds > 0 || (!force && lastAt != null && now - lastAt < MIN_GAP_MS)) return;
            running = true;
            lastAt = now;
        }
        round.run(() -> {
            synchronized (this) {
                running = false;
            }
            apply.run();
        });
    }
}
