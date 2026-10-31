package com.openmercato.cezar.mobile.shell;

/** The only thing a server page learns about the shell (spec Decision 2). */
public final class ShellUserAgent {
    private ShellUserAgent() {}

    public static String token(String version) {
        return "CezarMobile/" + version + " (android)";
    }
}
