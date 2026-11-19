package com.openmercato.cezar.mobile.shell;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** The server list as one JSON file. Unreadable means empty: state is never a boot failure. */
public final class ServerListStore {
    /** What the phone last knew of a server: when it last answered, and its counts (switcher spec). */
    public static final class Seen {
        /** Epoch ms; 0 before it ever answered. */
        public final long at;
        /** Null when unknown: never read, or a cezar that does not send them. */
        public final Integer waiting;
        public final Integer failed;

        Seen(long at, Integer waiting, Integer failed) {
            this.at = at;
            this.waiting = waiting;
            this.failed = failed;
        }

        /** waiting + failed, or null when neither is known. */
        public Integer need() {
            if (waiting == null && failed == null) return null;
            return (waiting == null ? 0 : waiting) + (failed == null ? 0 : failed);
        }

        static final Seen NEVER = new Seen(0, null, null);
    }

    private final File file;

    public ServerListStore(File directory) {
        this.file = new File(directory, "servers.json");
    }

    public synchronized List<ServerRecord> list() {
        List<ServerRecord> out = new ArrayList<>();
        JSONArray rows = read().optJSONArray("servers");
        if (rows == null) return out;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || row.optString("id", "").isEmpty()) continue;
            JSONObject relay = row.optJSONObject("relay");
            if (relay != null) {
                out.add(new ServerRecord(row.optString("id"), row.optString("label"), new RelayFields(relay.optString("origin"), relay.optString("cezarId"),
                        relay.optString("cezarKey"), relay.optString("deviceId"), relay.optInt("port")), text(row, "noteShown")));
                continue;
            }
            if (row.optString("url", "").isEmpty()) continue;
            out.add(new ServerRecord(row.optString("id"), row.optString("label"), row.optString("url"),
                    text(row, "username"), text(row, "realm"), text(row, "noteShown")));
        }
        return out;
    }

    public synchronized ServerRecord get(String id) {
        for (ServerRecord server : list()) if (server.id.equals(id)) return server;
        return null;
    }

    public synchronized ServerRecord findByUrl(String url) {
        for (ServerRecord server : list()) if (url.equals(server.url)) return server;
        return null;
    }

    public synchronized ServerRecord findPaired(String cezarId, String cezarKey) {
        for (ServerRecord server : list()) {
            if (server.relay != null && server.relay.cezarId.equals(cezarId) && server.relay.cezarKey.equals(cezarKey)) return server;
        }
        return null;
    }

    public synchronized String lastUsedId() {
        return text(read(), "lastUsedId");
    }

    public synchronized void put(ServerRecord server) {
        List<ServerRecord> servers = list();
        boolean replaced = false;
        for (int i = 0; i < servers.size(); i++) {
            if (servers.get(i).id.equals(server.id)) {
                servers.set(i, server);
                replaced = true;
            }
        }
        if (!replaced) servers.add(server);
        write(servers, lastUsedId());
    }

    public synchronized void remove(String id) {
        List<ServerRecord> servers = list();
        servers.removeIf(server -> server.id.equals(id));
        String last = lastUsedId();
        write(servers, id.equals(last) ? null : last);
    }

    public synchronized void markUsed(String id) {
        write(list(), id);
    }

    public synchronized Seen seen(String id) {
        JSONObject all = read().optJSONObject("seen");
        JSONObject row = all == null ? null : all.optJSONObject(id);
        if (row == null) return Seen.NEVER;
        return new Seen(row.optLong("at"), count(row, "waiting"), count(row, "failed"));
    }

    /** It answered at `at`; its counts stay as they were. */
    public synchronized void markSeen(String id, long at) {
        Seen was = seen(id);
        putSeen(id, new Seen(Math.max(at, was.at), was.waiting, was.failed));
    }

    /** Both counts from health: null clears them to unknown. */
    public synchronized void setCounts(String id, Integer waiting, Integer failed) {
        putSeen(id, new Seen(seen(id).at, waiting, failed));
    }

    /** A push's count is the waiting one (the relay's badge source); failed stays as last read. */
    public synchronized void setWaiting(String id, int waiting) {
        Seen was = seen(id);
        putSeen(id, new Seen(was.at, Math.max(0, waiting), was.failed));
    }

    /** The app-icon badge: the sum of last-known counts over every saved server. */
    public synchronized int totalNeed() {
        int total = 0;
        for (ServerRecord server : list()) {
            Integer need = seen(server.id).need();
            if (need != null) total += need;
        }
        return total;
    }

    private void putSeen(String id, Seen seen) {
        if (get(id) == null) return;
        JSONObject root = read();
        try {
            JSONObject all = root.optJSONObject("seen");
            if (all == null) all = new JSONObject();
            JSONObject row = new JSONObject().put("at", seen.at);
            if (seen.waiting != null) row.put("waiting", seen.waiting);
            if (seen.failed != null) row.put("failed", seen.failed);
            all.put(id, row);
            root.put("seen", all);
        } catch (JSONException e) {
            throw new IllegalStateException("cannot save the server list", e);
        }
        writeRoot(root);
    }

    private static Integer count(JSONObject row, String key) {
        Object value = row.opt(key);
        return value instanceof Number && ((Number) value).intValue() >= 0 ? ((Number) value).intValue() : null;
    }

    private static String text(JSONObject row, String key) {
        return row.isNull(key) ? null : row.optString(key);
    }

    private JSONObject read() {
        try {
            return new JSONObject(new String(FileBytes.read(file), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return new JSONObject();
        }
    }

    private void write(List<ServerRecord> servers, String lastUsedId) {
        try {
            JSONArray rows = new JSONArray();
            for (ServerRecord server : servers) {
                if (server.relay != null) {
                    rows.put(new JSONObject().put("id", server.id).put("label", server.label)
                            .put("noteShown", server.noteShown == null ? JSONObject.NULL : server.noteShown)
                            .put("relay", new JSONObject().put("origin", server.relay.origin).put("cezarId", server.relay.cezarId)
                                    .put("cezarKey", server.relay.cezarKey).put("deviceId", server.relay.deviceId).put("port", server.relay.port)));
                    continue;
                }
                rows.put(new JSONObject()
                        .put("id", server.id).put("label", server.label).put("url", server.url)
                        .put("username", server.username == null ? JSONObject.NULL : server.username)
                        .put("realm", server.realm == null ? JSONObject.NULL : server.realm)
                        .put("noteShown", server.noteShown == null ? JSONObject.NULL : server.noteShown));
            }
            JSONObject root = new JSONObject().put("servers", rows)
                    .put("lastUsedId", lastUsedId == null ? JSONObject.NULL : lastUsedId);
            // A forgotten server's counts go with it, so the badge never sums a ghost.
            JSONObject was = read().optJSONObject("seen");
            if (was != null) {
                JSONObject kept = new JSONObject();
                for (ServerRecord server : servers) if (was.has(server.id)) kept.put(server.id, was.get(server.id));
                root.put("seen", kept);
            }
            writeRoot(root);
        } catch (JSONException e) {
            throw new IllegalStateException("cannot save the server list", e);
        }
    }

    private void writeRoot(JSONObject root) {
        try {
            File tmp = new File(file.getPath() + ".tmp");
            FileBytes.write(tmp, root.toString().getBytes(StandardCharsets.UTF_8));
            // rename(2): replaces the old list atomically, within one directory.
            if (!tmp.renameTo(file)) throw new IOException("cannot replace " + file);
        } catch (IOException e) {
            throw new IllegalStateException("cannot save the server list", e);
        }
    }
}
