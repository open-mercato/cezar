package com.openmercato.cezar.mobile.shell;

import java.net.URI;
import java.net.URISyntaxException;

/** The connection plugin serves the bundled connect page and no one else (spec Decision 2). */
public final class OriginGate {
    private OriginGate() {}

    /** @param shellUrl the app's own start URL, such as https://localhost */
    public static boolean allows(String callerUrl, String shellUrl) {
        if (callerUrl == null || shellUrl == null) return false;
        try {
            URI caller = new URI(callerUrl);
            URI shell = new URI(shellUrl);
            return shell.getScheme() != null && shell.getScheme().equalsIgnoreCase(caller.getScheme())
                    && shell.getHost() != null && shell.getHost().equalsIgnoreCase(caller.getHost())
                    && shell.getPort() == caller.getPort();
        } catch (URISyntaxException e) {
            return false;
        }
    }
}
