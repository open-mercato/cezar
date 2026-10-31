package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class GatesTest {
    private static final String SHELL = "https://localhost";
    private static final NavigationPolicy.Action ALLOW = NavigationPolicy.Action.ALLOW;
    private static final NavigationPolicy.Action EXTERNAL = NavigationPolicy.Action.EXTERNAL;
    private static final NavigationPolicy.Action BLOCK = NavigationPolicy.Action.BLOCK;
    private static final String PAGE = "https://cezar.example.com/manager";

    private static ServerOrigin origin() throws Exception {
        return ServerOrigin.parse("https://cezar.example.com");
    }

    @Test
    public void thePluginServesTheConnectPage() {
        assertTrue(OriginGate.allows("https://localhost/index.html?x=1", SHELL));
    }

    @Test
    public void thePluginRefusesAServerOrigin() {
        assertFalse(OriginGate.allows("https://cezar.example.com/manager", SHELL));
        assertFalse(OriginGate.allows("http://localhost/", SHELL));
        assertFalse(OriginGate.allows("https://localhost:8443/", SHELL));
        assertFalse(OriginGate.allows("https://localhost.evil.com/", SHELL));
        assertFalse(OriginGate.allows("https://localhost@evil.com/", SHELL));
        assertFalse(OriginGate.allows(null, SHELL));
        assertFalse(OriginGate.allows("about:blank", SHELL));
        assertFalse(OriginGate.allows("https://localhost/", null));
    }

    @Test
    public void theGateStopsTheSameHostOnAnotherPortOrScheme() throws Exception {
        assertTrue(RequestGate.blocks(origin(), "https://cezar.example.com:9999/x"));
        assertTrue(RequestGate.blocks(origin(), "http://cezar.example.com/x"));
        assertFalse(RequestGate.blocks(origin(), "https://cezar.example.com/x"));
        assertFalse(RequestGate.blocks(origin(), "https://cdn.example.com/x"));
    }

    @Test
    public void serversLinkIsMainFrameOnly() throws Exception {
        assertEquals(NavigationPolicy.Action.SERVERS, NavigationPolicy.decide(origin(), "cezar://servers", PAGE, true, false));
        assertEquals(NavigationPolicy.Action.SERVERS, NavigationPolicy.decide(origin(), "cezar://servers/", PAGE, true, false));
        assertEquals(BLOCK, NavigationPolicy.decide(origin(), "cezar://servers", PAGE, false, false));
        assertEquals(BLOCK, NavigationPolicy.decide(origin(), "cezar://other", PAGE, true, false));
    }

    @Test
    public void linksOffTheOriginLeaveTheApp() throws Exception {
        assertEquals(EXTERNAL, NavigationPolicy.decide(origin(), "https://github.com/x", PAGE, true, false));
        assertEquals(EXTERNAL, NavigationPolicy.decide(origin(), "https://cezar.example.com:8443/", PAGE, true, false));
        assertEquals(EXTERNAL, NavigationPolicy.decide(origin(), "http://github.com/x", PAGE, true, false));
        assertEquals(EXTERNAL, NavigationPolicy.decide(origin(), "mailto:a@b.c", PAGE, true, false));
    }

    @Test
    public void linksOnTheOriginStay() throws Exception {
        assertEquals(ALLOW, NavigationPolicy.decide(origin(), "https://cezar.example.com/p/x", PAGE, true, false));
    }

    @Test
    public void anSsoRedirectStaysUntilItReturns() throws Exception {
        assertEquals(ALLOW, NavigationPolicy.decide(origin(), "https://sso.example.org/login", PAGE, true, true));
        assertEquals(ALLOW, NavigationPolicy.decide(origin(), "https://sso.example.org/next", "https://sso.example.org/login", true, false));
        assertEquals(EXTERNAL, NavigationPolicy.decide(origin(), "http://sso.example.org/login", PAGE, true, true));
    }

    @Test
    public void unknownSchemesAreBlocked() throws Exception {
        assertEquals(BLOCK, NavigationPolicy.decide(origin(), "intent://x#Intent;end", PAGE, true, false));
        assertEquals(BLOCK, NavigationPolicy.decide(origin(), "file:///etc/hosts", PAGE, true, false));
        assertEquals(BLOCK, NavigationPolicy.decide(origin(), "javascript:alert(1)", PAGE, true, false));
    }

    @Test
    public void windowsStayOnTheOriginOrLeave() throws Exception {
        assertEquals(ALLOW, NavigationPolicy.decideWindow(origin(), "https://cezar.example.com/p/x"));
        assertEquals(EXTERNAL, NavigationPolicy.decideWindow(origin(), "https://github.com/x"));
        assertEquals(BLOCK, NavigationPolicy.decideWindow(origin(), "intent://x"));
    }
}
