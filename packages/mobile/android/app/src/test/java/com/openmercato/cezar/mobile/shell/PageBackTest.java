package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PageBackTest {
    @Test
    public void onlyAPlainTrueMeansThePageTookIt() {
        assertTrue(PageBack.handled("true"));
        assertFalse(PageBack.handled("false"));
        assertFalse(PageBack.handled("null"));
        assertFalse(PageBack.handled(null));
        assertFalse(PageBack.handled("\"true\""));
    }
}
