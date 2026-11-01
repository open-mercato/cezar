package com.openmercato.cezar.mobile.shell.relay;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A relay address: scheme, host and port, no path (RELAY_PROTOCOL.md § 3, § 9.1). */
public final class RelayOrigin {
    public static final class Refused extends Exception {
        /** `version`, `cleartext` or `grammar`, the reasons in qr.json. */
        public final String reason;

        public Refused(String reason) {
            super(reason);
            this.reason = reason;
        }
    }

    static final Pattern ORIGIN = Pattern.compile("(https|http)://([a-z0-9.-]+|\\[::1\\])(?::([1-9][0-9]{0,4}))?");

    public final String origin;
    public final String socketOrigin;

    private RelayOrigin(String origin, String socketOrigin) {
        this.origin = origin;
        this.socketOrigin = socketOrigin;
    }

    /** The strict `origin` production. `debugBuild` is what admits the `http` rows of § 9.1. */
    public static RelayOrigin parse(String text, boolean debugBuild) throws Refused {
        Matcher match = ORIGIN.matcher(text == null ? "" : text);
        if (!match.matches()) throw new Refused("grammar");
        String port = match.group(3);
        if (port != null && Integer.parseInt(port) > 65535) throw new Refused("grammar");
        boolean secure = match.group(1).equals("https");
        if (!secure && !(debugBuild && isDevHost(match.group(2)))) throw new Refused("cleartext");
        return new RelayOrigin(text, (secure ? "wss" : "ws") + text.substring(secure ? 5 : 4));
    }

    /** What the Enter code field takes: `https://` is assumed with no scheme, one trailing `/` goes. */
    public static RelayOrigin parseTyped(String text, boolean debugBuild) throws Refused {
        String typed = text == null ? "" : text.trim();
        if (typed.endsWith("/")) typed = typed.substring(0, typed.length() - 1);
        if (!typed.contains("://")) typed = "https://" + typed;
        return parse(typed, debugBuild);
    }

    private static boolean isDevHost(String host) {
        return host.equals("127.0.0.1") || host.equals("localhost") || host.equals("[::1]") || host.equals("10.0.2.2");
    }
}
