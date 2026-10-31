package com.openmercato.cezar.mobile.shell;

/** Answers the webview's Basic challenge for one saved server (spec Decision 2). */
public final class BasicChallengeResponder {
    /** Reads the password only when a challenge passes every check. */
    public interface Passwords {
        String password(String serverId);
    }

    public enum Kind { ANSWER, CANCEL_FOREIGN, CANCEL_REJECTED, CANCEL_VERIFY }

    public static final class Reply {
        public final Kind kind;
        public final String username;
        public final String password;

        private Reply(Kind kind, String username, String password) {
            this.kind = kind;
            this.username = username;
            this.password = password;
        }
    }

    private final ServerRecord server;
    private final ServerOrigin origin;
    private final Passwords passwords;
    private boolean armed = true;

    public BasicChallengeResponder(ServerRecord server, Passwords passwords) {
        this.server = server;
        this.origin = server.origin();
        this.passwords = passwords;
    }

    /**
     * Android reports only host and realm, and a redirect hop never reaches
     * {@link RequestGate}, so a same-origin 302 to another port looks exactly like this server.
     * So the password goes out once, for the start URL: its path is `/`, which puts the whole origin
     * in the webview's auth cache. A later challenge is cancelled, and the caller probes to tell a
     * rotated password from a redirect.
     */
    public synchronized Reply onChallenge(String host, String realm, String pageUrl, boolean previousAttemptFailed) {
        boolean ours = server.realm != null && server.realm.equals(realm) && origin.host.equalsIgnoreCase(host)
                && origin.sameOrigin(pageUrl);
        if (!ours) return new Reply(Kind.CANCEL_FOREIGN, null, null);
        if (previousAttemptFailed) return new Reply(Kind.CANCEL_REJECTED, null, null);
        if (!armed) return new Reply(Kind.CANCEL_VERIFY, null, null);
        String password = passwords.password(server.id);
        if (password == null) return new Reply(Kind.CANCEL_REJECTED, null, null);
        armed = false;
        return new Reply(Kind.ANSWER, server.username, password);
    }

    /** The start page loaded, so the origin is cached, or needed no answer at all. */
    public synchronized void onStartPageLoaded() {
        armed = false;
    }
}
