package com.openmercato.cezar.mobile.shell;

/** Answers the webview's Basic challenge for one saved server, once (spec Decision 2). */
public final class BasicChallengeResponder {
    /** Reads the password only when a challenge passes every check. */
    public interface Passwords {
        String password(String serverId);
    }

    public enum Kind { ANSWER, CANCEL_FOREIGN, CANCEL_REJECTED }

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
    private boolean answered;

    public BasicChallengeResponder(ServerRecord server, Passwords passwords) {
        this.server = server;
        this.origin = server.origin();
        this.passwords = passwords;
    }

    /**
     * Android reports only host and realm, so the page URL stands in for scheme and port
     * (spec M2 item 10); {@link RequestGate} stops a sub-resource on another port before it asks.
     */
    public synchronized Reply onChallenge(String host, String realm, String pageUrl, boolean previousAttemptFailed) {
        boolean ours = server.realm != null && server.realm.equals(realm) && origin.host.equalsIgnoreCase(host)
                && origin.sameOrigin(pageUrl);
        if (!ours) return new Reply(Kind.CANCEL_FOREIGN, null, null);
        if (previousAttemptFailed || answered) return new Reply(Kind.CANCEL_REJECTED, null, null);
        String password = passwords.password(server.id);
        if (password == null) return new Reply(Kind.CANCEL_REJECTED, null, null);
        answered = true;
        return new Reply(Kind.ANSWER, server.username, password);
    }

    /** A page loaded, so the last answer was good and a later challenge gets one more. */
    public synchronized void onPageLoaded() {
        answered = false;
    }
}
