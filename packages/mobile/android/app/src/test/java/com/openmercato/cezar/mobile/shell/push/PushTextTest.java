package com.openmercato.cezar.mobile.shell.push;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class PushTextTest {
    @Test
    public void theTitleIsTheComputersNameOnThePhone() {
        assertEquals("Studio iMac", PushText.title("Studio iMac", "Cezar"));
        assertEquals("Build box", PushText.title("  Build box ", "Cezar"));
        assertEquals("Cezar", PushText.title("", "Cezar"));
        assertEquals("Cezar", PushText.title(null, "Cezar"));
    }

    @Test
    public void theCountComesFromDataThenTheNotification() {
        Map<String, String> data = new HashMap<>();
        data.put("s", "AAAAAAAAAAAAAAAAAAAAAA");
        assertNull(PushText.count(data, null));
        assertEquals(Integer.valueOf(2), PushText.count(data, 2));
        data.put("count", "5");
        assertEquals(Integer.valueOf(5), PushText.count(data, 2));
        data.put("count", "-1");
        assertEquals(Integer.valueOf(2), PushText.count(data, 2));
        data.put("count", "lots");
        assertNull(PushText.count(data, null));
        assertNull(PushText.count(Collections.emptyMap(), -3));
        assertNull(PushText.count(null, null));
    }

    @Test
    public void theNewestNumberMakesTheShownSumTheTotal() {
        assertEquals(7, PushText.number(7, 0));
        assertEquals(4, PushText.number(7, 3));
        // Always at least one: the notification itself is there.
        assertEquals(1, PushText.number(0, 0));
        assertEquals(1, PushText.number(2, 5));
        assertEquals(99, PushText.number(500, 0));
    }

    /** B3: a relay computer known to wait on nothing loses its notification; unknown and direct ones keep theirs. */
    @Test
    public void settledCezarsAreTheRelayOnesAtZero() {
        String[][] servers = { { "c-zero", "0" }, { "c-two", "2" }, { "c-unknown", null }, { null, "0" }, { "", "0" } };
        assertEquals(Arrays.asList("c-zero"), PushText.settled(Arrays.asList(servers), row -> row[0], row -> row[1] == null ? null : Integer.valueOf(row[1])));
    }
}
