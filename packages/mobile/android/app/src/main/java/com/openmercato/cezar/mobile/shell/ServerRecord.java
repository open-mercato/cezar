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

    public ServerRecord(String id, String label, String url, String username, String realm, String noteShown) {
        this.id = id;
        this.label = label;
        this.url = url;
        this.username = username;
        this.realm = realm;
        this.noteShown = noteShown;
    }

    public ServerRecord withNote(String note) {
        return new ServerRecord(id, label, url, username, realm, note);
    }

    public ServerOrigin origin() {
        try {
            return ServerOrigin.parse(url);
        } catch (ServerOrigin.InvalidUrl e) {
            throw new IllegalStateException("saved server has a bad url", e);
        }
    }
}
