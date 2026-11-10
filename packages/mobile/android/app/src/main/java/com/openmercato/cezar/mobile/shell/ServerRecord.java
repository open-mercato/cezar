package com.openmercato.cezar.mobile.shell;

/** One saved server. The password is never here: it lives in {@link CredentialStore} under id. */
public final class ServerRecord {
    public final String id;
    public final String label;
    public final String url;
    public final String username;
    /** The realm the password was saved for; null on a server with no Basic gate. */
    public final String realm;
    /** Which one-time note this server has shown; null before the first. */
    public final String noteShown;

    /** Set on a relay server, which then has a null {@link #url}. */
    public final RelayFields relay;

    public ServerRecord(String id, String label, String url, String username, String realm, String noteShown) {
        this(id, label, url, username, realm, noteShown, null);
    }

    public ServerRecord(String id, String label, RelayFields relay, String noteShown) {
        this(id, label, null, null, null, noteShown, relay);
    }

    private ServerRecord(String id, String label, String url, String username, String realm, String noteShown, RelayFields relay) {
        this.id = id;
        this.label = label;
        this.url = url;
        this.username = username;
        this.realm = realm;
        this.noteShown = noteShown;
        this.relay = relay;
    }

    public ServerRecord withNote(String note) {
        return new ServerRecord(id, label, url, username, realm, note, relay);
    }

    public ServerRecord withPort(int port) {
        return new ServerRecord(id, label, relay.withPort(port), noteShown);
    }

    public ServerOrigin origin() {
        try {
            return ServerOrigin.parse(url);
        } catch (ServerOrigin.InvalidUrl e) {
            throw new IllegalStateException("saved server has a bad url", e);
        }
    }
}
