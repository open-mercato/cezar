package com.openmercato.cezar.mobile.shell;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** The server list as one JSON file. Unreadable means empty: state is never a boot failure. */
public final class ServerListStore {
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

    private static String text(JSONObject row, String key) {
        return row.isNull(key) ? null : row.optString(key);
    }

    private JSONObject read() {
        try {
            return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
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
            File tmp = new File(file.getPath() + ".tmp");
            Files.write(tmp.toPath(), root.toString().getBytes(StandardCharsets.UTF_8));
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException | JSONException e) {
            throw new IllegalStateException("cannot save the server list", e);
        }
    }
}
