package com.openmercato.cezar.mobile.shell;

/** One-shot message from the server view back to the connect page. */
public final class ShellRoute {
    public final String screen;
    public final String serverId;

    private static ShellRoute pending;

    private ShellRoute(String screen, String serverId) {
        this.screen = screen;
        this.serverId = serverId;
    }

    public static synchronized void set(String screen, String serverId) {
        pending = new ShellRoute(screen, serverId);
    }

    public static synchronized ShellRoute take() {
        ShellRoute route = pending;
        pending = null;
        return route;
    }
}
