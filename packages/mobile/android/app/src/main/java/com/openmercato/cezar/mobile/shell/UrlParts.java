package com.openmercato.cezar.mobile.shell;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Scheme, host and port of a URL the webview reports. java.net.URI rejects characters the webview
 * leaves raw, such as `|`, and a rejected URL must not read as "not this host". `\` ends the
 * authority, as it does for the webview.
 */
final class UrlParts {
    private static final Pattern URL = Pattern.compile(
            "^([a-zA-Z][a-zA-Z0-9+.-]*):(?://(?:[^/?#\\\\]*@)?(\\[[^\\]/?#\\\\]*\\]|[^:/?#\\\\@]*)(?::([0-9]{0,5}))?(?=[/?#\\\\]|$))?");

    final String scheme;
    /** Lower case, null when the URL has no authority this class can read. */
    final String host;
    /** -1 when the URL names none. */
    final int port;

    private UrlParts(String scheme, String host, int port) {
        this.scheme = scheme;
        this.host = host;
        this.port = port;
    }

    /** Null for anything without a scheme. */
    static UrlParts parse(String url) {
        if (url == null) return null;
        Matcher match = URL.matcher(url);
        if (!match.find()) return null;
        String digits = match.group(3);
        int port = digits == null || digits.isEmpty() ? -1 : Integer.parseInt(digits);
        String host = match.group(2);
        return new UrlParts(match.group(1).toLowerCase(Locale.ROOT), host == null ? null : host.toLowerCase(Locale.ROOT), port);
    }
}
