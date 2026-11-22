package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** Spec 2026-11-20-phone-notifications-inbox, B1: a round on resume, and a minute's tick while a page is open. */
public class BadgeRefreshTest {
    private final List<Runnable> pending = new ArrayList<>();
    private final List<Long> delays = new ArrayList<>();
    private final List<Runnable> finish = new ArrayList<>();
    private long now = 1_763_208_000_000L;
    private int rounds;
    private int applied;

    private BadgeRefresh refresh() {
        return new BadgeRefresh(done -> {
            rounds++;
            finish.add(done);
        }, (ms, work) -> {
            delays.add(ms);
            pending.add(work);
        }, () -> now, () -> applied++);
    }

    private void fire() {
        List<Runnable> all = new ArrayList<>(pending);
        pending.clear();
        for (Runnable each : all) each.run();
    }

    @Test
    public void aResumeReadsEveryCezarOnceAndAppliesTheCounts() {
        BadgeRefresh badges = refresh();
        badges.resumed();
        badges.resumed();
        assertEquals("a resume while one runs joins it", 1, rounds);
        finish.remove(0).run();
        assertEquals(1, applied);
        now += 1000;
        badges.resumed();
        assertEquals("a resume right after reuses it", 1, rounds);
        now += BadgeRefresh.MIN_GAP_MS;
        badges.resumed();
        assertEquals(2, rounds);
    }

    @Test
    public void anOpenPageTicksEveryMinuteUntilItStops() {
        BadgeRefresh badges = refresh();
        badges.pageStarted("r");
        assertEquals(1, rounds);
        assertEquals(Arrays.asList(BadgeRefresh.PAGE_EVERY_MS), delays);
        finish.remove(0).run();
        fire();
        assertEquals("the tick reads again, whatever the gap", 2, rounds);
        assertEquals("and arms the next one", 1, pending.size());
        finish.remove(0).run();
        badges.pageStopped("r");
        fire();
        assertEquals(2, rounds);
        assertEquals("the page left: the tick stops", 0, pending.size());
    }

    @Test
    public void theDeviceSheetHoldsRoundsOffItsWarmLinks() {
        BadgeRefresh badges = refresh();
        badges.hold(true);
        badges.resumed();
        assertEquals(0, rounds);
        assertEquals("a round already running leaves the sheet's links", true, badges.held());
        badges.hold(false);
        assertEquals(false, badges.held());
        badges.resumed();
        assertEquals(1, rounds);
    }
}
