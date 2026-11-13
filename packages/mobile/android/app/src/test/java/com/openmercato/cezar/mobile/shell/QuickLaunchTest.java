package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class QuickLaunchTest {
    @Test
    public void aPlainStartWithACachedBundleOpensTheServerAtOnce() {
        assertTrue(QuickLaunch.applies(true, true, false, false, false, false, "/manager"));
    }

    @Test
    public void theLockTheRoutesAndTapsGoThroughTheConnectPage() {
        assertFalse("the lock answers first", QuickLaunch.applies(true, true, true, false, false, false, "/manager"));
        assertFalse("Servers or a pairing is waiting", QuickLaunch.applies(true, true, false, true, false, false, "/manager"));
        assertFalse("a notification picks the server", QuickLaunch.applies(true, true, false, false, true, false, "/manager"));
        assertFalse("one server view at a time", QuickLaunch.applies(true, true, false, false, false, true, "/manager"));
        assertFalse("no bundle on the phone: the probe decides", QuickLaunch.applies(true, true, false, false, false, false, null));
        assertFalse("a restored activity", QuickLaunch.applies(false, true, false, false, false, false, "/manager"));
        assertFalse("not from the launcher", QuickLaunch.applies(true, false, false, false, false, false, "/manager"));
    }

    @Test
    public void countsAsOpenUntilTheServerViewArrives() {
        QuickLaunch.started();
        assertTrue(QuickLaunch.launching());
        QuickLaunch.arrived();
        assertFalse(QuickLaunch.launching());
    }
}
