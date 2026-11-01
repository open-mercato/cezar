package com.openmercato.cezar.mobile.shell;

import java.util.List;
import java.util.UUID;

/** Add, open and forget: the connect flows, with no webview and no framework in sight. */
public final class ShellConnector {
    /** What the connect page or the server view does next. */
    public static final class Outcome {
        public final String screen;
        public final String serverId;
        /** Load this in the server view, when not null. */
        public final String url;
        public final String note;
        public final int status;

        Outcome(String screen, String serverId, String url, String note, int status) {
            this.screen = screen;
            this.serverId = serverId;
            this.url = url;
            this.note = note;
            this.status = status;
        }

        static Outcome screen(String screen, String serverId, int status) {
            return new Outcome(screen, serverId, null, null, status);
        }
    }

    public static final String OPEN = "open";
    public static final String LOGIN = "login";
    public static final String LIST = "list";
    public static final String ASK_CREDENTIALS = "ask-credentials";
    public static final String PASSWORD_REJECTED = "password-rejected";
    public static final String LOCAL_MODE = "local-mode";
    public static final String TLS_FAILURE = "tls-failure";
    public static final String NOT_CEZAR = "not-cezar";
    public static final String CONNECTION_ERROR = "connection-error";
    public static final String CLEARTEXT = "cleartext-refused";
    public static final String INVALID_URL = "invalid-url";
    public static final String CEZAR_OFFLINE = "cezar-offline";
    public static final String RELAY_DOWN = "relay-down";
    public static final String QUOTA = "quota";
    public static final String DEVICE_REMOVED = "device-removed";
    public static final String UPDATE_APP = "update-app";
    public static final String UPDATE_CEZAR = "update-cezar";

    /** The tunnel side of a relay server. Null on a shell with no relay, which then behaves as before. */
    public interface RelayPort {
        HealthAnswer probe(ServerRecord server);
        void goodbye(ServerRecord server);
        void forgetKeys(String id);
    }

    private final ServerListStore servers;
    private final CredentialStore credentials;
    private final HealthProbe probe;
    private final RelayPort relay;

    public ShellConnector(ServerListStore servers, CredentialStore credentials, HealthProbe probe) {
        this(servers, credentials, probe, null);
    }

    public ShellConnector(ServerListStore servers, CredentialStore credentials, HealthProbe probe, RelayPort relay) {
        this.servers = servers;
        this.credentials = credentials;
        this.probe = probe;
        this.relay = relay;
    }

    public List<ServerRecord> list() {
        return servers.list();
    }

    /** Cold launch: the last server used, else the list. */
    public Outcome launch(String cookiesForLast) {
        String last = servers.lastUsedId();
        return last == null || servers.get(last) == null ? Outcome.screen(LIST, null, 0) : open(last, cookiesForLast);
    }

    public Outcome open(String id, String cookies) {
        ServerRecord server = servers.get(id);
        if (server == null) return Outcome.screen(LIST, null, 0);
        if (server.relay != null) return openRelay(server);
        if (realmChanged(server, cookies)) return Outcome.screen(ASK_CREDENTIALS, id, 401);
        String password = credentials.get(id);
        HealthAnswer health = probe.probe(server.origin(), server.username, password, cookies);
        StartDecision.Route route = StartDecision.decide(health, password != null);
        switch (route) {
            case ASK_CREDENTIALS:
                return Outcome.screen(ASK_CREDENTIALS, id, health.status);
            case PASSWORD_REJECTED:
                return Outcome.screen(PASSWORD_REJECTED, id, health.status);
            case LOCAL_MODE:
                return Outcome.screen(LOCAL_MODE, id, health.status);
            case CONNECTION_ERROR:
                return Outcome.screen(health.kind == HealthAnswer.Kind.TLS_FAILURE ? TLS_FAILURE : CONNECTION_ERROR, id, health.status);
            default:
                servers.markUsed(id);
                return new Outcome(OPEN, id, server.origin().url(StartDecision.path(route)), oneTimeNote(server, route, health), health.status);
        }
    }

    /** The start table for a relay server. Basic routes cannot occur: it has no challenge. `url` is a path here. */
    private Outcome openRelay(ServerRecord server) {
        if (relay == null) return Outcome.screen(CONNECTION_ERROR, server.id, 0);
        HealthAnswer health = relay.probe(server);
        StartDecision.Route route = StartDecision.decide(health, false);
        switch (route) {
            case CEZAR_OFFLINE:
                return Outcome.screen(CEZAR_OFFLINE, server.id, 0);
            case RELAY_DOWN:
                return Outcome.screen(health.kind == HealthAnswer.Kind.QUOTA ? QUOTA : RELAY_DOWN, server.id, health.status);
            case DEVICE_REMOVED:
                return Outcome.screen(DEVICE_REMOVED, server.id, 0);
            case PROTOCOL_MISMATCH:
                return Outcome.screen(health.kind == HealthAnswer.Kind.UPDATE_APP ? UPDATE_APP : UPDATE_CEZAR, server.id, 0);
            case MANAGER:
            case ROOT_MANAGERS_OFF:
            case ROOT_OLD_SERVER:
                servers.markUsed(server.id);
                return new Outcome(OPEN, server.id, StartDecision.path(route), oneTimeNote(server, route, health), health.status);
            default:
                return Outcome.screen(CONNECTION_ERROR, server.id, health.status);
        }
    }

    /** Pairing succeeded: one row per cezar, whose old keys the new ones replace. */
    public String saveRelayServer(String label, RelayFields fields) {
        ServerRecord existing = servers.findByCezarId(fields.cezarId);
        String id = existing != null ? existing.id : UUID.randomUUID().toString();
        int port = existing != null ? existing.relay.port : 0;
        servers.put(new ServerRecord(id, label, fields.withPort(port), existing == null ? null : existing.noteShown));
        servers.markUsed(id);
        return id;
    }

    public void saveRelayPort(String id, int port) {
        ServerRecord server = servers.get(id);
        if (server != null && server.relay != null) servers.put(server.withPort(port));
    }

    /** Runs the add-server table. A retried answer goes back through it, so 403 after 401 explains. */
    public Outcome add(String url, String username, String password, String label) {
        ServerOrigin origin;
        try {
            origin = ServerOrigin.parse(url);
        } catch (ServerOrigin.InvalidUrl e) {
            return Outcome.screen(e.problem == ServerOrigin.Problem.CLEARTEXT ? CLEARTEXT : INVALID_URL, null, 0);
        }
        HealthAnswer first = probe.probe(origin, null, null, null);
        if (first.kind != HealthAnswer.Kind.BASIC_GATE) return afterAnswer(first, origin, null, null, null, label);
        if (password == null || password.isEmpty()) return Outcome.screen(ASK_CREDENTIALS, null, first.status);
        HealthAnswer retried = probe.probe(origin, username, password, null);
        return afterAnswer(retried, origin, username, password, first.realm, label);
    }

    /** The webview finished a page during an SSO add. Saves once health reads as cezar with its cookies. */
    public Outcome confirmLogin(String url, String cookies, String label) {
        ServerOrigin origin;
        try {
            origin = ServerOrigin.parse(url);
        } catch (ServerOrigin.InvalidUrl e) {
            return Outcome.screen(INVALID_URL, null, 0);
        }
        HealthAnswer health = probe.probe(origin, null, null, cookies);
        return health.kind == HealthAnswer.Kind.CEZAR ? save(origin, null, null, null, label, health)
                : Outcome.screen(LOGIN, null, health.status);
    }

    /** Deletes the password first: a list that outlives it can only re-ask. */
    public void forget(String id) {
        ServerRecord server = servers.get(id);
        if (server != null && server.relay != null && relay != null) {
            relay.goodbye(server);
            relay.forgetKeys(id);
        }
        credentials.delete(id);
        servers.remove(id);
    }

    public String lastUsedId() {
        return servers.lastUsedId();
    }

    public String password(String serverId) {
        return credentials.get(serverId);
    }

    public ServerRecord server(String serverId) {
        return servers.get(serverId);
    }

    /** Before the password goes out: a new realm gets no answer, and would strand a 401 page (BACKWARD_COMPATIBILITY.md §6b). */
    private boolean realmChanged(ServerRecord server, String cookies) {
        if (server.realm == null) return false;
        HealthAnswer bare = probe.probe(server.origin(), null, null, cookies);
        return bare.kind == HealthAnswer.Kind.BASIC_GATE && !server.realm.equals(bare.realm);
    }

    private Outcome afterAnswer(HealthAnswer health, ServerOrigin origin, String username, String password, String realm, String label) {
        switch (health.kind) {
            case CEZAR:
                return save(origin, username, password, realm, label, health);
            case BASIC_GATE:
                return Outcome.screen(PASSWORD_REJECTED, null, health.status);
            case LOCAL_MODE:
                return Outcome.screen(LOCAL_MODE, null, health.status);
            case LOGIN_PAGE:
                return new Outcome(LOGIN, null, origin.url("/"), null, health.status);
            case TLS_FAILURE:
                return Outcome.screen(TLS_FAILURE, null, 0);
            case UNREACHABLE:
                return Outcome.screen(CONNECTION_ERROR, null, 0);
            default:
                return Outcome.screen(NOT_CEZAR, null, health.status);
        }
    }

    private Outcome save(ServerOrigin origin, String username, String password, String realm, String label, HealthAnswer health) {
        ServerRecord existing = servers.findByUrl(origin.origin());
        String id = existing != null ? existing.id : UUID.randomUUID().toString();
        String name = label == null || label.trim().isEmpty() ? origin.host : label.trim();
        if (password != null) credentials.put(id, password);
        else credentials.delete(id);
        ServerRecord server = new ServerRecord(id, name, origin.origin(), username, realm, existing == null ? null : existing.noteShown);
        servers.put(server);
        servers.markUsed(id);
        StartDecision.Route route = StartDecision.decide(health, password != null);
        return new Outcome(OPEN, id, origin.url(StartDecision.path(route)), oneTimeNote(server, route, health), health.status);
    }

    private String oneTimeNote(ServerRecord server, StartDecision.Route route, HealthAnswer health) {
        String note;
        if (route == StartDecision.Route.ROOT_MANAGERS_OFF) {
            note = "Manager is turned off on this server.";
        } else if (route == StartDecision.Route.ROOT_OLD_SERVER) {
            note = "This server runs cezar " + health.version + ", which has no Manager. Update it with cezar server-deploy.";
        } else {
            return null;
        }
        if (note.equals(server.noteShown)) return null;
        servers.put(server.withNote(note));
        return note;
    }
}
