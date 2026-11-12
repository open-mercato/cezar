package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LaunchHoldTest {
    private long now = 1000;
    private final LaunchHold hold = new LaunchHold(() -> now);

    @Test
    public void holdsUntilReleased() {
        assertFalse(hold.holding());
        hold.start();
        assertTrue(hold.holding());
        hold.release();
        assertFalse(hold.holding());
    }

    @Test
    public void neverLongerThanTheCap() {
        hold.start();
        now += LaunchHold.MAX_MS;
        assertFalse("a start that never resolves still shows the app", hold.holding());
    }
}
