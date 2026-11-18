package com.openmercato.cezar.mobile.shell.push;

import com.openmercato.cezar.mobile.shell.FileBytes;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Push state as one JSON file in the no-backup directory. Unreadable means empty: push off, nothing owed. */
public final class PushStore {
    /** One server's switch and grant. */
    public static final class Server {
        public final boolean enabled;
        /** cezar may hold a grant from this phone, so turning the switch off owes it a `DELETE`. */
        public final boolean held;
        public final PushGrant grant;

        public Server(boolean enabled, boolean held, PushGrant grant) {
            this.enabled = enabled;
            this.held = held;
            this.grant = grant;
        }

        static final Server OFF = new Server(false, false, null);
    }

    /** A grant still to be denied at the relay (§ 7). `forgotten`: its server is gone, and its device key waits for this. */
    public static final class Revoke {
        public final String serverId;
        public final String label;
        public final String origin;
        public final String grant;
        public final long expiresAt;
        public final long notBefore;
        public final int attempts;
        public final boolean forgotten;

        public Revoke(String serverId, String label, String origin, String grant, long expiresAt, long notBefore, int attempts, boolean forgotten) {
            this.serverId = serverId;
            this.label = label;
            this.origin = origin;
            this.grant = grant;
            this.expiresAt = expiresAt;
            this.notBefore = notBefore;
            this.attempts = attempts;
            this.forgotten = forgotten;
        }

        public Revoke retryAt(long when) {
            return new Revoke(serverId, label, origin, grant, expiresAt, when, attempts + 1, forgotten);
        }
    }

    private final File file;

    public PushStore(File directory) {
        this.file = new File(directory, "push.json");
    }

    public synchronized boolean asked() {
        return read().optBoolean("asked", false);
    }

    public synchronized void setAsked() {
        JSONObject root = read();
        put(root, "asked", true);
        write(root);
    }

    public synchronized Server server(String id) {
        JSONObject servers = read().optJSONObject("servers");
        JSONObject row = servers == null ? null : servers.optJSONObject(id);
        if (row == null) return Server.OFF;
        JSONObject grant = row.optJSONObject("grant");
        return new Server(row.optBoolean("enabled", false), row.optBoolean("held", false), grant == null ? null : grantOf(grant));
    }

    public synchronized void putServer(String id, Server server) {
        JSONObject root = read();
        JSONObject servers = root.optJSONObject("servers");
        if (servers == null) servers = new JSONObject();
        try {
            JSONObject row = new JSONObject().put("enabled", server.enabled).put("held", server.held);
            if (server.grant != null) {
                PushGrant g = server.grant;
                row.put("grant", new JSONObject().put("grant", g.grant).put("grantId", g.grantId).put("expiresAt", g.expiresAt)
                        .put("cezarKey", g.cezarKey).put("handedOver", g.handedOver));
            }
            servers.put(id, row);
            root.put("servers", servers);
        } catch (JSONException e) {
            throw new IllegalStateException("cannot save push state", e);
        }
        write(root);
    }

    public synchronized void removeServer(String id) {
        JSONObject root = read();
        JSONObject servers = root.optJSONObject("servers");
        if (servers == null) return;
        servers.remove(id);
        put(root, "renew", without(root.optJSONArray("renew"), id));
        write(root);
    }

    /** FCM rotated the token: this server's grant names a dead one until a new grant is got. Never the token itself. */
    public synchronized void setRenew(String id, boolean owed) {
        JSONObject root = read();
        JSONArray rest = without(root.optJSONArray("renew"), id);
        if (owed) rest.put(id);
        put(root, "renew", rest);
        write(root);
    }

    public synchronized boolean renewOwed(String id) {
        JSONArray rows = read().optJSONArray("renew");
        if (rows == null) return false;
        for (int i = 0; i < rows.length(); i++) if (id.equals(rows.optString(i))) return true;
        return false;
    }

    public synchronized List<Revoke> revokes() {
        List<Revoke> out = new ArrayList<>();
        JSONArray rows = read().optJSONArray("revokes");
        if (rows == null) return out;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || row.optString("grant", "").isEmpty() || row.optString("origin", "").isEmpty()) continue;
            out.add(new Revoke(row.optString("serverId"), row.optString("label"), row.optString("origin"), row.optString("grant"),
                    row.optLong("expiresAt"), row.optLong("notBefore"), row.optInt("attempts"), row.optBoolean("forgotten")));
        }
        return out;
    }

    public synchronized void setRevokes(List<Revoke> revokes) {
        JSONObject root = read();
        JSONArray rows = new JSONArray();
        try {
            for (Revoke r : revokes) {
                rows.put(new JSONObject().put("serverId", r.serverId).put("label", r.label).put("origin", r.origin).put("grant", r.grant)
                        .put("expiresAt", r.expiresAt).put("notBefore", r.notBefore).put("attempts", r.attempts).put("forgotten", r.forgotten));
            }
            root.put("revokes", rows);
        } catch (JSONException e) {
            throw new IllegalStateException("cannot save push state", e);
        }
        write(root);
    }

    /** Server ids with state, for a token change. */
    public synchronized List<String> serverIds() {
        List<String> out = new ArrayList<>();
        JSONObject servers = read().optJSONObject("servers");
        if (servers == null) return out;
        for (Iterator<String> keys = servers.keys(); keys.hasNext(); ) out.add(keys.next());
        return out;
    }

    private static JSONArray without(JSONArray rows, String id) {
        JSONArray out = new JSONArray();
        if (rows == null) return out;
        for (int i = 0; i < rows.length(); i++) if (!id.equals(rows.optString(i))) out.put(rows.optString(i));
        return out;
    }

    private static PushGrant grantOf(JSONObject row) {
        String grant = row.optString("grant", "");
        String grantId = row.optString("grantId", "");
        String cezarKey = row.optString("cezarKey", "");
        if (grant.isEmpty() || grantId.isEmpty() || cezarKey.isEmpty()) return null;
        return new PushGrant(grant, grantId, row.optLong("expiresAt"), cezarKey, row.optBoolean("handedOver"));
    }

    private static void put(JSONObject root, String key, Object value) {
        try {
            root.put(key, value);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private JSONObject read() {
        try {
            return new JSONObject(new String(FileBytes.read(file), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return new JSONObject();
        }
    }

    private void write(JSONObject root) {
        try {
            File tmp = new File(file.getPath() + ".tmp");
            FileBytes.write(tmp, root.toString().getBytes(StandardCharsets.UTF_8));
            if (!tmp.renameTo(file)) throw new IOException("cannot replace " + file);
        } catch (IOException e) {
            throw new IllegalStateException("cannot save push state", e);
        }
    }
}
