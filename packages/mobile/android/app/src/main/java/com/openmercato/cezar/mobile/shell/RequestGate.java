package com.openmercato.cezar.mobile.shell;

/** Stops a request to the server's host on another scheme or port, before it can raise a challenge. */
public final class RequestGate {
    private RequestGate() {}

    public static boolean blocks(ServerOrigin origin, String url) {
        return origin.sameHost(url) && !origin.sameOrigin(url);
    }
}
