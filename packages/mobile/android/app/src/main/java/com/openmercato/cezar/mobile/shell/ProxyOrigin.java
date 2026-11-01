package com.openmercato.cezar.mobile.shell;

/** The exact `http://127.0.0.1:<port>` of a relay server's page: never a general `http` allowance (spec). */
public final class ProxyOrigin implements PageOrigin {
    public final int port;

    public ProxyOrigin(int port) {
        this.port = port;
    }

    @Override
    public String origin() {
        return "http://127.0.0.1:" + port;
    }

    @Override
    public String url(String path) {
        return origin() + path;
    }

    @Override
    public boolean sameOrigin(String url) {
        UrlParts parts = UrlParts.parse(url);
        return parts != null && "http".equals(parts.scheme) && "127.0.0.1".equals(parts.host) && parts.port == port;
    }

    /** Every loopback spelling counts, so another port under any of them is blocked. */
    @Override
    public boolean sameHost(String url) {
        UrlParts parts = UrlParts.parse(url);
        return parts != null && ("127.0.0.1".equals(parts.host) || "localhost".equals(parts.host) || "[::1]".equals(parts.host));
    }

    @Override
    public boolean allowsSso() {
        return false;
    }
}
