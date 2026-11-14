package com.openmercato.cezar.mobile.shell.push;

import com.openmercato.cezar.mobile.shell.HttpAnswer;
import com.openmercato.cezar.mobile.shell.relay.Bytes;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/** `/api/v1/workspace/phone/push`, asked inside the server's own session (spec R5 as built). */
public final class CezarPush {
    public static final String PATH = "/api/v1/workspace/phone/push";

    /** One request inside the session. The app passes the tunnel's; tests pass a fake. */
    public interface Http {
        HttpAnswer send(String method, String path, Map<String, String> headers, byte[] body) throws IOException;
    }

    /** `phonePushStateSchema`. */
    public static final class State {
        public final boolean available;
        /** cezar's Ed25519 key, checked to be 32 bytes of base64url; null otherwise. */
        public final String cezarKey;
        public final String grantId;
        public final long grantExpiresAt;
        public final String managerId;

        public State(boolean available, String cezarKey, String grantId, long grantExpiresAt, String managerId) {
            this.available = available;
            this.cezarKey = cezarKey;
            this.grantId = grantId;
            this.grantExpiresAt = grantExpiresAt;
            this.managerId = managerId;
        }

        /** A cezar too old to have the route, or with push off. */
        public static final State OFF = new State(false, null, null, 0, null);

        /** Readers ignore unknown keys. A key that is not 32 bytes reads as push off: no grant can name it. */
        public static State parse(String json) throws IOException {
            try {
                JSONObject body = new JSONObject(json);
                String key = text(body, "cezarKey");
                boolean usable = key != null && Bytes.fromBase64url(key, 32) != null;
                return new State(body.optBoolean("available", false) && usable, usable ? key : null, text(body, "grantId"),
                        body.optLong("grantExpiresAt", 0), text(body, "managerId"));
            } catch (JSONException e) {
                throw new IOException("cezar sent bad push state");
            }
        }

        private static String text(JSONObject body, String key) {
            Object value = body.opt(key);
            return value instanceof String ? (String) value : null;
        }
    }

    private final Http http;
    private final String userAgent;

    public CezarPush(Http http, String userAgent) {
        this.http = http;
        this.userAgent = userAgent;
    }

    public State get() throws IOException {
        HttpAnswer answer = http.send("GET", PATH, headers(false), null);
        if (answer.status == 404) return State.OFF;
        if (answer.status != 200) throw new IOException("cezar answered " + answer.status);
        return State.parse(answer.body);
    }

    /** Null when cezar has push off (409). */
    public State put(PushGrant grant) throws IOException {
        String body;
        try {
            body = new JSONObject().put("grant", grant.grant).put("grantId", grant.grantId).put("expiresAt", grant.expiresAt).toString();
        } catch (JSONException e) {
            throw new IOException("cannot write the grant");
        }
        HttpAnswer answer = http.send("PUT", PATH, headers(true), body.getBytes(StandardCharsets.UTF_8));
        if (answer.status == 409) return null;
        if (answer.status != 200) throw new IOException("cezar answered " + answer.status);
        return State.parse(answer.body);
    }

    public void delete() throws IOException {
        HttpAnswer answer = http.send("DELETE", PATH, headers(false), null);
        // 404: a cezar with no such route holds no grant either.
        if (answer.status != 200 && answer.status != 404) throw new IOException("cezar answered " + answer.status);
    }

    private Map<String, String> headers(boolean json) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "application/json");
        headers.put("User-Agent", userAgent);
        if (json) headers.put("Content-Type", "application/json");
        return headers;
    }
}
