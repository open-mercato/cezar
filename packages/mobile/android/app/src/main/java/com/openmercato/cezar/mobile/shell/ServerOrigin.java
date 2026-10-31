package com.openmercato.cezar.mobile.shell;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** An https scheme, host and port: the only identity a saved server has (spec Decision 2). */
public final class ServerOrigin {
    public enum Problem { CLEARTEXT, INVALID }

    public static final class InvalidUrl extends Exception {
        public final Problem problem;

        InvalidUrl(Problem problem) {
            super(problem.name());
            this.problem = problem;
        }
    }

    public final String host;
    public final int port;

    private ServerOrigin(String host, int port) {
        this.host = host;
        this.port = port;
    }

    /** Takes what the user typed. A bare host means https; http is refused, spec Q5. */
    public static ServerOrigin parse(String input) throws InvalidUrl {
        String text = input == null ? "" : input.trim();
        if (text.isEmpty()) throw new InvalidUrl(Problem.INVALID);
        if (!text.contains("://")) text = "https://" + text;
        URI uri;
        try {
            uri = new URI(text);
        } catch (URISyntaxException e) {
            throw new InvalidUrl(Problem.INVALID);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.equals("http")) throw new InvalidUrl(Problem.CLEARTEXT);
        boolean rootPath = uri.getRawPath() == null || uri.getRawPath().isEmpty() || uri.getRawPath().equals("/");
        // A password in the URL is refused rather than stripped: it must never be stored or logged.
        if (!scheme.equals("https") || uri.getHost() == null || uri.getRawUserInfo() != null
                || !rootPath || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new InvalidUrl(Problem.INVALID);
        }
        return new ServerOrigin(uri.getHost().toLowerCase(Locale.ROOT), uri.getPort() == -1 ? 443 : uri.getPort());
    }

    public String origin() {
        return port == 443 ? "https://" + host : "https://" + host + ":" + port;
    }

    public String url(String path) {
        return origin() + path;
    }

    /** False for anything that does not parse, so an odd URL can never pass as this server. */
    public boolean sameOrigin(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            int urlPort = uri.getPort() == -1 ? 443 : uri.getPort();
            return "https".equalsIgnoreCase(uri.getScheme()) && host.equalsIgnoreCase(uri.getHost()) && port == urlPort;
        } catch (URISyntaxException e) {
            return false;
        }
    }

    public boolean sameHost(String url) {
        if (url == null) return false;
        try {
            return host.equalsIgnoreCase(new URI(url).getHost());
        } catch (URISyntaxException e) {
            return false;
        }
    }
}
