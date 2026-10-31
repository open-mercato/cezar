package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class ServerOriginTest {
    private static ServerOrigin.Problem problem(String input) {
        try {
            ServerOrigin.parse(input);
            fail("accepted " + input);
            return null;
        } catch (ServerOrigin.InvalidUrl e) {
            return e.problem;
        }
    }

    @Test
    public void normalizes() throws Exception {
        assertEquals("https://cezar.example.com", ServerOrigin.parse(" HTTPS://Cezar.Example.com/ ").origin());
        assertEquals("https://cezar.example.com", ServerOrigin.parse("cezar.example.com").origin());
        assertEquals("https://cezar.example.com", ServerOrigin.parse("https://cezar.example.com:443").origin());
        assertEquals("https://cezar.example.com:8443", ServerOrigin.parse("https://cezar.example.com:8443").origin());
    }

    @Test
    public void refusesCleartext() {
        assertEquals(ServerOrigin.Problem.CLEARTEXT, problem("http://cezar.example.com"));
        assertEquals(ServerOrigin.Problem.CLEARTEXT, problem("HTTP://cezar.example.com"));
    }

    @Test
    public void refusesCredentialsPathsAndOtherSchemes() {
        assertEquals(ServerOrigin.Problem.INVALID, problem("https://me:secret@cezar.example.com"));
        assertEquals(ServerOrigin.Problem.INVALID, problem("https://cezar.example.com/sub"));
        assertEquals(ServerOrigin.Problem.INVALID, problem("https://cezar.example.com/?x=1"));
        assertEquals(ServerOrigin.Problem.INVALID, problem("ftp://cezar.example.com"));
        assertEquals(ServerOrigin.Problem.INVALID, problem(""));
        assertEquals(ServerOrigin.Problem.INVALID, problem(null));
        assertEquals(ServerOrigin.Problem.INVALID, problem("not a url"));
    }

    @Test
    public void sameOriginIsExact() throws Exception {
        ServerOrigin origin = ServerOrigin.parse("https://cezar.example.com");
        assertTrue(origin.sameOrigin("https://cezar.example.com/manager?x=1"));
        assertTrue(origin.sameOrigin("https://CEZAR.example.com:443/"));
        assertFalse(origin.sameOrigin("http://cezar.example.com/"));
        assertFalse(origin.sameOrigin("https://cezar.example.com:8443/"));
        assertFalse(origin.sameOrigin("https://cezar.example.com.evil.com/"));
        assertFalse(origin.sameOrigin("https://cezar.example.com@evil.com/"));
        assertFalse(origin.sameOrigin("https://evil.com\\@cezar.example.com/"));
        assertFalse(origin.sameOrigin(null));
    }

    @Test
    public void readsWhatTheWebviewLeavesRaw() throws Exception {
        ServerOrigin origin = ServerOrigin.parse("https://cezar.example.com");
        assertTrue(origin.sameOrigin("https://cezar.example.com/x?q=a|b^{c}"));
        assertFalse(origin.sameOrigin("https://cezar.example.com:8443/x?q=a|b"));
        assertFalse(origin.sameOrigin("https://evil.com#@cezar.example.com/"));
        assertFalse(origin.sameOrigin("https://cezar.example.com:notaport/"));
        assertFalse(ServerOrigin.parse("https://mail.example.com").sameOrigin("https://ma\u0131l.example.com/"));
        assertFalse(ServerOrigin.parse("https://mail.example.com").sameOrigin("https://MA\u0130L.example.com/"));
        assertFalse(origin.sameOrigin("https://cezar.example.com:\u0664\u0664\u0663/"));
        assertTrue(ServerOrigin.parse("https://[::1]:8443").sameOrigin("https://[::1]:8443/x"));
    }
}
