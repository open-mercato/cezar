package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** A signal for the server on screen shows nothing (spec R5, Stage 1). */
public class ForegroundServersTest {
    private final ForegroundServers servers = new ForegroundServers();

    @Test
    public void onlyTheServerOnScreenIsSilenced() {
        assertTrue(servers.shouldNotify("a"));
        servers.started("a");
        assertFalse(servers.shouldNotify("a"));
        assertTrue("another server still notifies", servers.shouldNotify("b"));
        servers.stopped("a");
        assertTrue("in the grace window the page is off screen", servers.shouldNotify("a"));
    }

    @Test
    public void twoViewsOfOneServerStayForegroundUntilBothStop() {
        servers.started("a");
        servers.started("a");
        servers.stopped("a");
        assertFalse(servers.shouldNotify("a"));
        servers.stopped("a");
        servers.stopped("a");
        assertTrue(servers.shouldNotify("a"));
    }

    @Test
    public void noServerIdNeverNotifies() {
        servers.started(null);
        servers.stopped(null);
        assertFalse(servers.shouldNotify(null));
    }
}
