package com.openmercato.cezar.mobile.shell;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The switcher spec's golden vectors: the web and iOS pin the same ones. */
public class AvatarTest {
    private static void golden(String name, int color, String initials) {
        assertEquals(name, Integer.toHexString(color), Integer.toHexString(Avatar.color(name)));
        assertEquals(name, initials, Avatar.initials(name));
    }

    @Test
    public void goldenVectors() {
        golden("Studio iMac", 0xFF7C6CF0, "SI");
        golden("Build box", 0xFF22B3A0, "BB");
        golden("MacBook Pro", 0xFF2A9FD8, "MP");
        golden("Home server", 0xFFE05A73, "HS");
        golden("patryk-mbp", 0xFF2A9FD8, "P");
        golden("Żółw", 0xFFE0912A, "Ż");
        golden("a", 0xFFE0912A, "A");
        golden("Mac 🍎 mini", 0xFFE05A73, "MM");
        golden("🍎", 0xFFE05A73, "");
    }

    @Test
    public void surroundingSpaceIsNotPartOfTheName() {
        assertEquals(Avatar.color("Build box"), Avatar.color("  Build box\t"));
        assertEquals("BB", Avatar.initials("  Build   box "));
    }

    @Test
    public void unicodeSpaceSplitsAndTrimsAsJavaScriptDoes() {
        assertEquals("BB", Avatar.initials("\u00A0Build\u3000box\u2009"));
        assertEquals(Avatar.color("Build box"), Avatar.color("\uFEFFBuild box\u00A0"));
    }

    @Test
    public void anEmptyNameHasNoLetters() {
        assertEquals("", Avatar.initials(""));
        assertEquals("", Avatar.initials(null));
        assertEquals(0xFF7C6CF0, Avatar.color(""));
    }
}
